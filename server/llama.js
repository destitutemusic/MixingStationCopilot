import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(__dirname, '..');

const BIN_DIRS = {
	linux: ['linux-x64', 'llama-server'],
	darwin: ['linux-x64', 'llama-server'],
	win32: ['win-x64', 'llama-server.exe'],
};

/** Resolve the llama-server binary path for the current platform. */
export function resolveLlamaBinary(platform = process.platform) {
	const [dir, file] = BIN_DIRS[platform] ?? BIN_DIRS.linux;
	return path.join(ROOT_DIR, 'bin', dir, file);
}

/** True when the binary exists and is executable. */
export function checkLlamaBinary(binaryPath = resolveLlamaBinary()) {
	try {
		accessSync(binaryPath, constants.X_OK);
		return { ok: true, path: binaryPath };
	} catch {
		return { ok: false, path: binaryPath, error: `not found or not executable: ${binaryPath}` };
	}
}

/**
 * Spawn llama-server as a sidecar and wait until its OpenAI-compatible
 * endpoint reports healthy. Rejects if the process dies before becoming
 * ready. Returns `{ child, baseUrl, logs }`.
 */
export function startLlama({ port, modelPath, onLog = () => {} }) {
	const binaryCheck = checkLlamaBinary();
	if (!binaryCheck.ok) return Promise.reject(new Error(binaryCheck.error));
	if (!existsSync(modelPath)) return Promise.reject(new Error(`model file not found: ${modelPath}`));

	const binaryPath = binaryCheck.path;
	const binDir = path.dirname(binaryPath);
	const env = { ...process.env };
	if (process.platform !== 'win32') env.LD_LIBRARY_PATH = [binDir, env.LD_LIBRARY_PATH].filter(Boolean).join(':');

	// Memory is tight on typical hosts (this project targets ~5.7 GB boxes): a
	// single slot and explicit 4k context keep the KV cache + compute buffers
	// small enough to malloc, which llama.cpp's fit check would otherwise abort on.
	const args = ['--model', modelPath, '--port', String(port), '--host', '0.0.0.0', '--jinja', '--parallel', '1', '--ctx-size', '4096'];
	const child = spawn(binaryPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });

	const logs = [];
	const pushLog = (chunk) => {
		const line = chunk.toString().trimEnd();
		if (!line) return;
		logs.push(line);
		if (logs.length > 200) logs.shift();
		onLog(line);
	};
	child.stdout.on('data', pushLog);
	child.stderr.on('data', pushLog);

	let settled = false;
	const settle = (fn) => {
		if (settled) return;
		settled = true;
		fn();
	};
	const fail = (error) => {
		// Never leave an unmanaged sidecar behind: if we give up on it, stop it.
		if (child.exitCode === null) child.kill('SIGKILL');
		settle(() => reject(error));
	};

	const healthUrl = `http://127.0.0.1:${port}/health`;
	const pollHealth = (deadline, resolve, reject) => {
		if (child.exitCode !== null) {
			return fail(new Error(`llama-server exited before ready (code ${child.exitCode}):\n${logs.slice(-10).join('\n')}`));
		}
		fetch(healthUrl, { signal: AbortSignal.timeout(2000) })
			.then((res) => (res.ok ? res.json() : Promise.reject(new Error(`health HTTP ${res.status}`))))
			.then((body) => {
				if (body && body.status === 'ok') {
					settle(() => resolve({ child, baseUrl: `http://127.0.0.1:${port}`, logs }));
				} else if (Date.now() < deadline) {
					setTimeout(() => pollHealth(deadline, resolve, reject), 1000);
				} else {
					fail(new Error(`llama-server did not become healthy in time\n${logs.slice(-10).join('\n')}`));
				}
			})
			.catch(() => {
				if (Date.now() < deadline) setTimeout(() => pollHealth(deadline, resolve, reject), 1000);
				else fail(new Error(`llama-server did not become healthy in time\n${logs.slice(-10).join('\n')}`));
			});
	};

	// Kill the sidecar when this Node process exits, no matter how.
	process.on('exit', () => {
		if (child.exitCode === null) child.kill('SIGKILL');
	});

	return new Promise((resolve, reject) => {
		const deadline = Date.now() + 600_000; // first CPU model load of a 4.4 GB GGUF can take several minutes
		child.on('error', (error) => settle(() => reject(new Error(`failed to spawn llama-server: ${error.message}`))));
		pollHealth(deadline, resolve, reject);
	});
}

/** Gracefully stop a spawned llama-server; falls back to SIGKILL. */
export function stopLlama(child) {
	if (!child || child.exitCode !== null || child.signalCode !== null) return;
	child.kill('SIGTERM');
	setTimeout(() => {
		if (child.exitCode === null) child.kill('SIGKILL');
	}, 3000);
}
