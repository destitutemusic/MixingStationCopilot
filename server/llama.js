import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(__dirname, '..');

/**
 * The directory names the first-run downloader writes into `bin/`.
 * `darwin` maps to `mac`, never to a Linux build — the old table sent every
 * Mac user at the Linux ELF, which cannot execute on macOS.
 */
const OS_KEY = { win32: 'win', darwin: 'mac', linux: 'linux' };
const ARCH_KEY = { x64: 'x64', arm64: 'arm64' };

export function detectPlatform(platform = process.platform, arch = process.arch) {
	const osKey = OS_KEY[platform] ?? null;
	const archKey = ARCH_KEY[arch] ?? null;
	return {
		platform,
		arch,
		os: osKey,
		archKey,
		dir: osKey && archKey ? `${osKey}-${archKey}` : null,
	};
}

export function llamaBinaryName(platform = process.platform) {
	return platform === 'win32' ? 'llama-server.exe' : 'llama-server';
}

/** `bin/<platform>-<arch>/llama-server[.exe]`, resolved for the current machine. */
export function llamaBinaryPath(platform = process.platform, arch = process.arch) {
	const det = detectPlatform(platform, arch);
	return path.join(ROOT_DIR, 'bin', det.dir ?? 'unsupported', llamaBinaryName(platform));
}

/** Resolve the llama-server binary path for the current platform and architecture. */
export function resolveLlamaBinary(platform = process.platform, arch = process.arch) {
	return llamaBinaryPath(platform, arch);
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
 *
 * `host` defaults to 127.0.0.1 so the model server is not exposed to the
 * venue wifi. Widening it is an explicit, documented opt-in.
 */
export function startLlama({ port, modelPath, host = '127.0.0.1', onLog = () => {} }) {
	const binaryCheck = checkLlamaBinary();
	if (!binaryCheck.ok) return Promise.reject(new Error(binaryCheck.error));
	if (!existsSync(modelPath)) return Promise.reject(new Error(`model file not found: ${modelPath}`));

	const binaryPath = binaryCheck.path;
	const binDir = path.dirname(binaryPath);
	const env = { ...process.env };
	if (process.platform !== 'win32') {
		env.LD_LIBRARY_PATH = [binDir, env.LD_LIBRARY_PATH].filter(Boolean).join(':');
		env.DYLD_LIBRARY_PATH = [binDir, env.DYLD_LIBRARY_PATH].filter(Boolean).join(':');
	}

	// Memory is tight on typical hosts: a single slot and explicit 8k context keep
	// the KV cache + compute buffers small enough to malloc.
	const args = ['--model', modelPath, '--port', String(port), '--host', host, '--jinja', '--parallel', '1', '--ctx-size', '8192'];
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

	process.on('exit', () => {
		if (child.exitCode === null) child.kill('SIGKILL');
	});

	return new Promise((resolve, reject) => {
		const deadline = Date.now() + 600_000;
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
