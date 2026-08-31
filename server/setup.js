import { accessSync, constants, statSync } from 'node:fs';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { resolveLlamaBinary, ROOT_DIR } from './llama.js';

export const MODEL_CATALOG = [
	{
		id: 'functionary-small-v2.5',
		label: 'Functionary Small 2.5 (recommended)',
		filename: 'functionary-small-v2.5.Q4_0.gguf',
		url: 'https://huggingface.co/meetkai/functionary-small-v2.5-GGUF/resolve/main/functionary-small-v2.5.Q4_0.gguf',
		sizeBytes: 4_661_212_000,
		ramNote: '8 GB+ RAM recommended',
	},
	{
		id: 'qwen2.5-1.5b',
		label: 'Qwen2.5 1.5B (light)',
		filename: 'qwen2.5-1.5b-instruct-q4_k_m.gguf',
		url: 'https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf',
		sizeBytes: 1_100_000_000,
		ramNote: '4 GB+ RAM, older PCs',
	},
];

export const DEFAULT_MODEL_FILENAME = MODEL_CATALOG[0].filename;
export const DEFAULT_MODEL_URL = MODEL_CATALOG[0].url;

export function defaultModelPath() {
	return path.join(ROOT_DIR, 'models', DEFAULT_MODEL_FILENAME);
}

/** Find a catalog entry by id; falls back to the default (first) entry. */
export function modelById(id) {
	return MODEL_CATALOG.find((m) => m.id === id) ?? MODEL_CATALOG[0];
}

/** Which catalog entries already have their file on disk? */
export function modelAvailability() {
	return MODEL_CATALOG.map((m) => {
		const p = path.join(ROOT_DIR, 'models', m.filename);
		let present = false;
		try {
			present = statSync(p).size >= 1024 * 1024;
		} catch {
			present = false;
		}
		return { id: m.id, label: m.label, sizeBytes: m.sizeBytes, ramNote: m.ramNote, present, path: p };
	});
}

const MIN_VALID_MODEL_BYTES = 1024 * 1024; // 1 MiB sanity floor; the real model is ~4.4 GiB
const GGUF_MAGIC = Buffer.from('GGUF');

export function checkNode() {
	const [major, version] = [Number(process.versions.node.split('.')[0]), process.versions.node];
	return { ok: major >= 20, major, version };
}

export function checkModelFile(modelPath = defaultModelPath()) {
	try {
		const size = statSync(modelPath).size;
		return { ok: size >= MIN_VALID_MODEL_BYTES, path: modelPath, sizeBytes: size, valid: size >= MIN_VALID_MODEL_BYTES };
	} catch {
		return { ok: false, path: modelPath, sizeBytes: 0, valid: false };
	}
}

function checkLlamaBinaryLocal() {
	try {
		const binaryPath = resolveLlamaBinary();
		accessSync(binaryPath, constants.X_OK);
		return { ok: true, path: binaryPath };
	} catch (error) {
		return { ok: false, error: error.message };
	}
}

/** Mixing Station is reachable when its REST API answers any HTTP status. */
export async function checkMixingStation({ host, port }, timeoutMs = 3000) {
	try {
		const res = await fetch(`http://${host}:${port}/app/state`, { signal: AbortSignal.timeout(timeoutMs) });
		return { ok: true, status: res.status, url: `http://${host}:${port}` };
	} catch (error) {
		return { ok: false, error: error.message, url: `http://${host}:${port}` };
	}
}

export async function checkLlamaServer(port, timeoutMs = 3000) {
	try {
		const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
		if (!res.ok) return { ok: false, status: res.status };
		const body = await res.json();
		return { ok: body.status === 'ok', status: res.status };
	} catch {
		return { ok: false };
	}
}

export async function runSetupChecks({ msHost, msPort, llamaPort, modelPath }) {
	const node = checkNode();
	const llamaBinary = checkLlamaBinaryLocal();
	const modelFile = checkModelFile(modelPath);
	const mixingStation = await checkMixingStation({ host: msHost, port: msPort });
	const llamaServer = await checkLlamaServer(llamaPort);

	let needs = null;
	if (!node.ok) needs = 'node';
	else if (!llamaBinary.ok) needs = 'llama-binary';
	else if (!modelFile.ok) needs = 'model';
	else if (!mixingStation.ok) needs = 'ms';
	else if (!llamaServer.ok) needs = 'llama-start';

	const ready = node.ok && llamaBinary.ok && modelFile.ok && mixingStation.ok && llamaServer.ok;
	return { node, llamaBinary, modelFile, mixingStation, llamaServer, ready, needs, modelPath };
}

/**
 * Stream a model download to disk with progress reporting. Verifies the GGUF
 * magic bytes so a truncated/corrupt download is rejected instead of loaded.
 */
export async function downloadModel({ url = DEFAULT_MODEL_URL, dest = defaultModelPath(), onProgress = () => {} }) {
	const res = await fetch(url, { redirect: 'follow' });
	if (!res.ok) throw new Error(`download failed: HTTP ${res.status} from ${url}`);
	if (!res.body) throw new Error('download failed: response has no body');

	const total = Number(res.headers.get('content-length')) || 0;
	let received = 0;
	const tmp = `${dest}.part`;
	const file = createWriteStream(tmp);
	let lastEmit = 0;

	const reader = res.body.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		file.write(value);
		received += value.length;
		const now = Date.now();
		if (now - lastEmit > 100 || received === total) {
			lastEmit = now;
			onProgress({ received, total, percent: total ? Math.round((received / total) * 100) : 0 });
		}
	}
	await new Promise((resolve, reject) => file.end((error) => (error ? reject(error) : resolve())));

	// Validate the GGUF header before treating the download as usable.
	const { open } = await import('node:fs/promises');
	const header = await open(tmp, 'r');
	try {
		const buf = Buffer.alloc(4);
		await header.read(buf, 0, 4, 0);
		if (!buf.equals(GGUF_MAGIC)) throw new Error('downloaded file is not a valid GGUF model (bad magic bytes)');
	} finally {
		await header.close();
	}
	const size = statSync(tmp).size;
	if (size < MIN_VALID_MODEL_BYTES) throw new Error('downloaded model is suspiciously small; refusing to use it');

	const { rename } = await import('node:fs/promises');
	await rename(tmp, dest);
	onProgress({ received: size, total: size || total, percent: 100 });
	return { path: dest, sizeBytes: size };
}
