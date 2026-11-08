import { accessSync, constants, createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { cpSync, chmodSync, renameSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import os from 'node:os';
import AdmZip from 'adm-zip';

import { detectPlatform, llamaBinaryPath, ROOT_DIR } from './llama.js';

/**
 * The model catalogue. Every entry MUST be able to follow the app's
 * `TOOL_CALL: name` text protocol (Qwen3 instruct models do); a model that
 * cannot emit tool calls is not a candidate however small it is.
 *
 * `minRamGb` is the TOTAL system RAM we recommend, with headroom for the OS,
 * Mixing Station and a browser — not the bare model footprint. The UI shows
 * the recommendation and the user may override it.
 */
export const MODEL_CATALOG = [
	{
		id: 'qwen3-0.6b',
		label: 'Qwen3 0.6B',
		filename: 'Qwen3-0.6B-Q4_K_M.gguf',
		url: 'https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q4_K_M.gguf',
		sizeBytes: 396_705_472,
		parameters: '0.6B',
		quantisation: 'Q4_K_M',
		minRamGb: 4,
		ramNote: '4 GB+ system RAM',
		licence: 'Apache-2.0',
		toolCalling: true,
		description: 'Fastest, smallest download. Fine for simple one-step commands; it will mis-handle longer or multi-step requests.',
	},
	{
		id: 'qwen3-1.7b',
		label: 'Qwen3 1.7B',
		filename: 'Qwen3-1.7B-Q4_K_M.gguf',
		url: 'https://huggingface.co/unsloth/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q4_K_M.gguf',
		sizeBytes: 1_107_409_472,
		parameters: '1.7B',
		quantisation: 'Q4_K_M',
		minRamGb: 6,
		ramNote: '6 GB+ system RAM',
		licence: 'Apache-2.0',
		toolCalling: true,
		description: 'Good balance for most laptops. Handles ordinary mixer requests and short multi-step edits.',
	},
	{
		id: 'qwen3-4b',
		label: 'Qwen3 4B',
		filename: 'Qwen3-4B-Q4_K_M.gguf',
		url: 'https://huggingface.co/unsloth/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf',
		sizeBytes: 2_497_281_312,
		parameters: '4B',
		quantisation: 'Q4_K_M',
		minRamGb: 8,
		ramNote: '8 GB+ system RAM',
		licence: 'Apache-2.0',
		toolCalling: true,
		description: 'Recommended for most machines. Markedly more reliable at structured tool calls and multi-step requests.',
	},
	{
		id: 'qwen3-8b',
		label: 'Qwen3 8B',
		filename: 'Qwen3-8B-Q4_K_M.gguf',
		url: 'https://huggingface.co/unsloth/Qwen3-8B-GGUF/resolve/main/Qwen3-8B-Q4_K_M.gguf',
		sizeBytes: 5_027_784_512,
		parameters: '8B',
		quantisation: 'Q4_K_M',
		minRamGb: 12,
		ramNote: '12 GB+ system RAM',
		licence: 'Apache-2.0',
		toolCalling: true,
		description: 'Best all-round choice on a 16 GB machine. Noticeably better at complex or ambiguous requests.',
	},
	{
		id: 'qwen3-14b',
		label: 'Qwen3 14B',
		filename: 'Qwen3-14B-Q4_K_M.gguf',
		url: 'https://huggingface.co/unsloth/Qwen3-14B-GGUF/resolve/main/Qwen3-14B-Q4_K_M.gguf',
		sizeBytes: 9_001_753_984,
		parameters: '14B',
		quantisation: 'Q4_K_M',
		minRamGb: 20,
		ramNote: '20 GB+ system RAM',
		licence: 'Apache-2.0',
		toolCalling: true,
		description: 'The strongest option for complex multi-step mixing. Needs a large machine and a long first download.',
	},
];

export function systemRamGb() {
	return Math.max(1, Math.round(os.totalmem() / 1024 ** 3));
}

/** Largest tier whose TOTAL-RAM requirement fits; never the largest that technically loads. */
export function recommendedModelId(totalRamGb = systemRamGb()) {
	const fits = MODEL_CATALOG.filter((m) => m.minRamGb <= totalRamGb);
	const pool = fits.length ? fits : [MODEL_CATALOG[0]];
	return pool.reduce((best, m) => (m.minRamGb > best.minRamGb ? m : best), pool[0]).id;
}

export const DEFAULT_MODEL_ID = recommendedModelId();
export const DEFAULT_MODEL_FILENAME = MODEL_CATALOG.find((m) => m.id === DEFAULT_MODEL_ID).filename;
export const DEFAULT_MODEL_URL = MODEL_CATALOG.find((m) => m.id === DEFAULT_MODEL_ID).url;

export function defaultModelPath() {
	return path.join(ROOT_DIR, 'models', DEFAULT_MODEL_FILENAME);
}

/** Find a catalog entry by id; falls back to the machine's recommended tier. */
export function modelById(id) {
	return MODEL_CATALOG.find((m) => m.id === id) ?? MODEL_CATALOG.find((m) => m.id === DEFAULT_MODEL_ID) ?? MODEL_CATALOG[0];
}

/** Which catalog entries already have their file on disk, and the recommendation. */
export function modelAvailability(totalRamGb = systemRamGb()) {
	const recommended = recommendedModelId(totalRamGb);
	return MODEL_CATALOG.map((m) => {
		const p = path.join(ROOT_DIR, 'models', m.filename);
		let present = false;
		try {
			present = statSync(p).size >= 1024 * 1024;
		} catch {
			present = false;
		}
		return { ...m, recommended: m.id === recommended, present, path: p };
	});
}

// ---------------------------------------------------------------------------
// llama.cpp — downloaded at first run, never committed.
// ---------------------------------------------------------------------------

export const LLAMA_VERSION = 'b12211';
export const LLAMA_BASE_URL = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_VERSION}`;

/**
 * Pinned release assets. `sizeBytes` and `sha256` come from the GitHub release
 * API for that tag; both are verified after download. `kind` selects the
 * extractor (`zip` via adm-zip, `tar.gz` via the system tar already present on
 * macOS and Linux). `strip` is the single top-level directory inside the
 * macOS/Linux tarballs.
 */
export const LLAMA_BUILDS = {
	'win-x64': {
		asset: `llama-${LLAMA_VERSION}-bin-win-cpu-x64.zip`,
		kind: 'zip',
		sizeBytes: 24_886_431,
		sha256: '23729000408c6968faf5e322afc99319d3b8c576ba872ef7663d9b89810090f3',
		binary: 'llama-server.exe',
	},
	'win-arm64': {
		asset: `llama-${LLAMA_VERSION}-bin-win-cpu-arm64.zip`,
		kind: 'zip',
		sizeBytes: 13_236_751,
		sha256: 'bf52f65602d713a4a13ed366a8ba8d924558bb43be04b7a37f4f5f506a6b6512',
		binary: 'llama-server.exe',
	},
	'mac-arm64': {
		asset: `llama-${LLAMA_VERSION}-bin-macos-arm64.tar.gz`,
		kind: 'tar.gz',
		sizeBytes: 16_711_245,
		sha256: '4da4edb437358d31d55938ad849d262ca31b0e0ffb35e9caedb727a0cd5a8f0f',
		binary: 'llama-server',
		strip: `llama-${LLAMA_VERSION}`,
	},
	'mac-x64': {
		asset: `llama-${LLAMA_VERSION}-bin-macos-x64.tar.gz`,
		kind: 'tar.gz',
		sizeBytes: 12_455_590,
		sha256: '6055cc672cc5c744481bb88ac1a7739ff476966c8a190ddaa20676034693a358',
		binary: 'llama-server',
		strip: `llama-${LLAMA_VERSION}`,
	},
	'linux-x64': {
		asset: `llama-${LLAMA_VERSION}-bin-ubuntu-x64.tar.gz`,
		kind: 'tar.gz',
		sizeBytes: 23_109_987,
		sha256: '962924b5431bc1237a9e5d26ba072d37b6fe05f79b495206e7ff6134887624c5',
		binary: 'llama-server',
		strip: `llama-${LLAMA_VERSION}`,
	},
	'linux-arm64': {
		asset: `llama-${LLAMA_VERSION}-bin-ubuntu-arm64.tar.gz`,
		kind: 'tar.gz',
		sizeBytes: 18_759_007,
		sha256: '6eed2da01c098f814170e941e11a8d91eed200a9a2923eac805fe116b14aff30',
		binary: 'llama-server',
		strip: `llama-${LLAMA_VERSION}`,
	},
};

export function llamaBuildFor(platform = process.platform, arch = process.arch) {
	const det = detectPlatform(platform, arch);
	return { det, build: det.dir ? LLAMA_BUILDS[det.dir] : null };
}

export function llamaStatus(platform = process.platform, arch = process.arch) {
	const { det, build } = llamaBuildFor(platform, arch);
	const binaryPath = llamaBinaryPath(platform, arch);
	let present = false;
	try {
		accessSync(binaryPath, constants.X_OK);
		present = true;
	} catch {
		present = false;
	}
	return {
		platform,
		arch,
		dir: det.dir,
		supported: Boolean(build),
		present,
		path: binaryPath,
		version: LLAMA_VERSION,
		url: build ? `${LLAMA_BASE_URL}/${build.asset}` : null,
		sizeBytes: build ? build.sizeBytes : null,
	};
}

/** Plain-language failure text: platform string + the URL that failed, never a stack. */
export function friendlyDownloadError(error, { what, platform, url }) {
	const reason = error && error.message ? error.message : String(error);
	return `Could not download the ${what} for ${platform}. URL: ${url}. ${reason}`;
}

function sha256File(filePath) {
	const hash = createHash('sha256');
	return new Promise((resolve, reject) => {
		const input = createReadStream(filePath);
		input.on('data', (chunk) => hash.update(chunk));
		input.on('end', () => resolve(hash.digest('hex')));
		input.on('error', reject);
	});
}

/**
 * Stream one file to disk with progress, then verify exact size and (when
 * pinned) sha256 before renaming it into place.
 */
async function downloadToFile({ url, dest, sizeBytes, sha256, onProgress = () => {}, stage = 'download' }) {
	const res = await fetch(url, { redirect: 'follow' });
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	if (!res.body) throw new Error('the server sent no file body');

	const total = Number(res.headers.get('content-length')) || sizeBytes || 0;
	const hash = createHash('sha256');
	const tmp = `${dest}.part`;
	mkdirSync(path.dirname(dest), { recursive: true });
	const file = createWriteStream(tmp);
	let received = 0;
	let lastEmit = 0;

	const reader = res.body.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		hash.update(value);
		file.write(value);
		received += value.length;
		const now = Date.now();
		if (now - lastEmit > 120 || received === total) {
			lastEmit = now;
			onProgress({ stage, received, total, percent: total ? Math.round((received / total) * 100) : 0 });
		}
	}
	await new Promise((resolve, reject) => file.end((error) => (error ? reject(error) : resolve())));

	if (sizeBytes && received !== sizeBytes) {
		unlinkSync(tmp);
		throw new Error(`downloaded ${received} bytes, expected ${sizeBytes}`);
	}
	if (sha256) {
		const actual = await sha256File(tmp);
		if (actual !== sha256) {
			unlinkSync(tmp);
			throw new Error(`checksum mismatch (expected ${sha256.slice(0, 12)}…, got ${actual.slice(0, 12)}…)`);
		}
	}
	renameSync(tmp, dest);
	onProgress({ stage, received, total: received, percent: 100 });
	return { path: dest, sizeBytes: received };
}

function findFile(root, name) {
	const stack = [root];
	while (stack.length) {
		const dir = stack.pop();
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) stack.push(full);
			else if (entry.name === name) return full;
		}
	}
	return null;
}

function extractArchive(archive, build, destDir) {
	const work = mkdtempSync(path.join(tmpdir(), 'msc-llama-'));
	try {
		if (build.kind === 'zip') {
			new AdmZip(archive).extractAllTo(work, true);
		} else {
			const result = spawnSync('tar', ['-xzf', archive, '-C', work], { stdio: 'ignore' });
			if (result.status !== 0) throw new Error('could not unpack the archive (tar failed)');
		}
		const binary = findFile(work, build.binary);
		if (!binary) throw new Error(`the archive did not contain ${build.binary}`);
		const sourceDir = build.strip ? path.join(work, build.strip) : path.dirname(binary);
		if (!existsSync(sourceDir)) throw new Error(`the archive did not contain the expected ${build.strip}/ folder`);
		mkdirSync(destDir, { recursive: true });
		for (const entry of readdirSync(sourceDir)) {
			cpSync(path.join(sourceDir, entry), path.join(destDir, entry), { recursive: true, force: true, verbatimSymlinks: true });
		}
		const placed = path.join(destDir, build.binary);
		if (!existsSync(placed)) throw new Error(`could not place ${build.binary}`);
		if (process.platform !== 'win32') chmodSync(placed, 0o755);
		return placed;
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

/**
 * Ensure `bin/<platform>-<arch>/llama-server` exists, downloading the pinned
 * official build if it does not. Progress events carry `stage: 'llama'`.
 */
export async function ensureLlamaBinary({ platform = process.platform, arch = process.arch, onProgress = () => {} } = {}) {
	const status = llamaStatus(platform, arch);
	if (status.present) return { ...status, downloaded: false };

	const { det, build } = llamaBuildFor(platform, arch);
	if (!build) {
		throw new Error(
			`This computer (${platform}/${arch}) is not a platform we ship an AI engine for. ` +
				'You can still use MsMcp with an AI client you already have.',
		);
	}
	const url = `${LLAMA_BASE_URL}/${build.asset}`;
	const destDir = path.dirname(llamaBinaryPath(platform, arch));
	const archive = path.join(tmpdir(), `msc-${build.asset}`);
	onProgress({ stage: 'llama', received: 0, total: build.sizeBytes, percent: 0, platform: det.dir });
	try {
		await downloadToFile({
			url,
			dest: archive,
			sizeBytes: build.sizeBytes,
			sha256: build.sha256,
			stage: 'llama',
			onProgress,
		});
		const placed = extractArchive(archive, build, destDir);
		return { ...status, present: true, path: placed, downloaded: true };
	} catch (error) {
		throw new Error(friendlyDownloadError(error, { what: 'AI engine (llama.cpp)', platform: det.dir, url }));
	} finally {
		try {
			unlinkSync(archive);
		} catch {
			/* already gone */
		}
	}
}

const MIN_VALID_MODEL_BYTES = 1024 * 1024;
const GGUF_MAGIC = Buffer.from('GGUF');

export function checkNode() {
	const major = Number(process.versions.node.split('.')[0]);
	return { ok: major >= 20, major, version: process.versions.node };
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
	const status = llamaStatus();
	if (!status.supported) return { ok: false, error: `no AI engine build for ${process.platform}/${process.arch}` };
	if (!status.present) return { ok: false, error: `AI engine not downloaded yet (${status.dir})`, path: status.path };
	return { ok: true, path: status.path };
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
	const llama = llamaStatus();
	const ramGb = systemRamGb();

	let needs = null;
	if (!node.ok) needs = 'node';
	else if (!llamaBinary.ok) needs = 'llama-binary';
	else if (!modelFile.ok) needs = 'model';
	else if (!mixingStation.ok) needs = 'ms';
	else if (!llamaServer.ok) needs = 'llama-start';

	const ready = node.ok && llamaBinary.ok && modelFile.ok && mixingStation.ok && llamaServer.ok;
	return {
		node,
		llamaBinary,
		modelFile,
		mixingStation,
		llamaServer,
		ready,
		needs,
		modelPath,
		platform: llama,
		ramGb,
		recommendedModelId: recommendedModelId(ramGb),
	};
}

/**
 * Stream a model download to disk with progress reporting. Verifies the exact
 * catalogue size and GGUF magic bytes so a truncated/corrupt download is
 * rejected instead of loaded.
 */
export async function downloadModel({ url = DEFAULT_MODEL_URL, dest = defaultModelPath(), sizeBytes, onProgress = () => {} }) {
	try {
		const result = await downloadToFile({ url, dest, sizeBytes, stage: 'model', onProgress });
		const { open } = await import('node:fs/promises');
		const header = await open(dest, 'r');
		try {
			const buf = Buffer.alloc(4);
			await header.read(buf, 0, 4, 0);
			if (!buf.equals(GGUF_MAGIC)) throw new Error('the downloaded file is not a valid GGUF model');
		} finally {
			await header.close();
		}
		return result;
	} catch (error) {
		throw new Error(friendlyDownloadError(error, { what: 'AI model', platform: `${process.platform}/${process.arch}`, url }));
	}
}
