import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

import { MixingStationClient } from '../vendor/msmcp/mixingstation.js';
import { ParameterDiscovery } from '../vendor/msmcp/discovery.js';
import { MsMcpGateway } from '../vendor/msmcp/msmcp-gateway.js';

import { startLlama, stopLlama, checkLlamaBinary } from './llama.js';
import { createAgent } from './agent.js';
import { defaultModelPath, DEFAULT_MODEL_URL, downloadModel, runSetupChecks, MODEL_CATALOG, modelById, modelAvailability } from './setup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');

const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.ico': 'image/x-icon',
	'.webmanifest': 'application/manifest+json',
};

function parseArgs(argv) {
	const args = { msHost: 'localhost', msPort: 8080, llamaPort: 8090, webPort: 8085, modelPath: defaultModelPath(), modelUrl: DEFAULT_MODEL_URL, noLlama: false };
	for (let i = 0; i < argv.length; i += 1) {
		const flag = argv[i];
		const value = () => {
			i += 1;
			return argv[i];
		};
		if (flag === '--help') {
			console.log(`Usage: node server/index.js [--ms-host H] [--ms-port P] [--llama-port P] [--web-port P] [--model-path FILE] [--model-url URL] [--no-llama]`);
			process.exit(0);
		} else if (flag === '--ms-host') args.msHost = value();
		else if (flag === '--ms-port') args.msPort = Number(value());
		else if (flag === '--llama-port') args.llamaPort = Number(value());
		else if (flag === '--web-port') args.webPort = Number(value());
		else if (flag === '--model-path') args.modelPath = path.resolve(value());
		else if (flag === '--model-url') args.modelUrl = value();
		else if (flag === '--no-llama') args.noLlama = true;
		else throw new Error(`unknown option: ${flag}`);
	}
	return args;
}

async function loadConfig(cliArgs) {
	let file = {};
	try {
		file = JSON.parse(await readFile(path.join(ROOT_DIR, 'config.json'), 'utf8'));
	} catch {
		// config.json is optional; defaults apply.
	}
	return {
		msHost: cliArgs.msHost,
		msPort: cliArgs.msPort,
		llamaPort: cliArgs.llamaPort,
		webPort: cliArgs.webPort,
		modelPath: cliArgs.modelPath,
		modelUrl: cliArgs.modelUrl,
		noLlama: cliArgs.noLlama,
		configFile: file,
	};
}

function sendJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) });
	res.end(payload);
}

async function serveStatic(req, res, urlPath) {
	const decoded = decodeURIComponent(urlPath);
	const rel = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
	const filePath = path.resolve(PUBLIC_DIR, rel);
	if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
		sendJson(res, 403, { error: 'forbidden' });
		return;
	}
	try {
		const info = await stat(filePath);
		if (!info.isFile()) throw new Error('not a file');
		const ext = path.extname(filePath).toLowerCase();
		const body = await readFile(filePath);
		res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream', 'Content-Length': body.length });
		res.end(body);
	} catch {
		sendJson(res, 404, { error: 'not found' });
	}
}

async function main() {
	const cliArgs = parseArgs(process.argv.slice(2));
	const config = await loadConfig(cliArgs);

	const state = {
		config,
		client: null,
		gateway: null,
		agent: null,
		parameters: [],
		msStatus: 'unknown',
		msError: null,
		llama: null,
		llamaError: null,
		download: null, // { state, received, total, percent, error }
		shuttingDown: false,
	};

	const wss = new WebSocketServer({ noServer: true });
	const broadcast = (payload) => {
		const text = JSON.stringify(payload);
		for (const client of wss.clients) {
			if (client.readyState === WebSocket.OPEN) client.send(text);
		}
	};

	// ---- Mixing Station connection (auto-retry) ----
	async function connectMixingStation() {
		if (state.shuttingDown) return;
		const { msHost, msPort } = config;
		const client = new MixingStationClient({ host: msHost, port: msPort, timeoutMs: 4000 });
		try {
			await client.connect();
			const parameters = await new ParameterDiscovery(client).discover();
			if (parameters.length === 0) throw new Error('no parameters discovered on mixer');
			const gateway = new MsMcpGateway(client, parameters);
			state.client = client;
			state.gateway = gateway;
			state.parameters = parameters;
			state.msStatus = 'connected';
			state.msError = null;
			state.agent = await createAgent({
				gateway,
				llamaBaseUrl: state.llama ? state.llama.baseUrl : `http://127.0.0.1:${config.llamaPort}`,
				onEvent: (event) => broadcast({ type: 'event', ...event }),
			});
			console.log(`[ms] connected to ${client.url}, discovered ${parameters.length} parameters`);
		} catch (error) {
			state.client?.close();
			state.client = null;
			state.gateway = null;
			state.agent = null;
			state.msStatus = 'error';
			state.msError = error.message;
			console.log(`[ms] not reachable (${error.message}); retrying in 5s`);
			setTimeout(connectMixingStation, 5000);
		}
	}

	// ---- llama-server sidecar ----
	async function startSidecar() {
		if (state.shuttingDown || config.noLlama || state.llama) return;
		const binary = checkLlamaBinary();
		if (!binary.ok) {
			state.llamaError = binary.error;
			return;
		}
		try {
			console.log(`[llama] starting ${binary.path} on port ${config.llamaPort}…`);
			state.llama = await startLlama({ port: config.llamaPort, modelPath: config.modelPath, onLog: (line) => console.log(`[llama] ${line}`) });
			state.llamaError = null;
			console.log(`[llama] ready at ${state.llama.baseUrl}`);
			broadcast({ type: 'setup', ...(await runSetupChecks({ ...config, modelPath: config.modelPath })) });
		} catch (error) {
			state.llama = null;
			state.llamaError = error.message;
			console.error(`[llama] failed: ${error.message}`);
		}
	}

	async function triggerSetupCheck() {
		return runSetupChecks({ msHost: config.msHost, msPort: config.msPort, llamaPort: config.llamaPort, modelPath: config.modelPath });
	}

	// ---- HTTP server ----
	const server = createServer((req, res) => {
		const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
		const pathname = url.pathname;

		if (req.method === 'GET' && pathname === '/api/health') {
			sendJson(res, 200, {
				ok: true,
				mixingStation: { connected: state.msStatus === 'connected' },
				llama: { ready: Boolean(state.llama), error: state.llamaError },
				model: { present: state.config.modelPath !== null },
			});
			return;
		}

		if (req.method === 'GET' && pathname === '/api/setup/check') {
			triggerSetupCheck().then((result) => sendJson(res, 200, result));
			return;
		}

		if (req.method === 'GET' && pathname === '/api/setup/models') {
			sendJson(res, 200, modelAvailability());
			return;
		}

		if (req.method === 'GET' && pathname === '/api/setup/download') {
			sendJson(res, 200, state.download ?? { state: 'idle', percent: 0 });
			return;
		}

		if (req.method === 'POST' && pathname === '/api/setup/download') {
			if (state.download && state.download.state === 'downloading') {
				sendJson(res, 200, { started: false, message: 'download already in progress' });
				return;
			}
			let body = '';
			req.on('data', (c) => (body += c));
			req.on('end', () => {
			let modelId = null;
			try { modelId = JSON.parse(body || '{}').modelId ?? null; } catch { modelId = null; }
			const entry = modelId ? modelById(modelId) : null;
			const dlUrl = entry ? entry.url : config.modelUrl;
			const dlDest = entry ? path.join(ROOT_DIR, 'models', entry.filename) : config.modelPath;
			config.modelUrl = dlUrl;
			config.modelPath = dlDest;
			state.download = { state: 'downloading', received: 0, total: 0, percent: 0, error: null };
			downloadModel({
				url: dlUrl,
				dest: dlDest,
				onProgress: (p) => {
					state.download = { ...state.download, ...p };
					broadcast({ type: 'download', ...state.download });
				},
			})
				.then(async (result) => {
					state.download = { state: 'done', received: result.sizeBytes, total: result.sizeBytes, percent: 100, error: null };
					broadcast({ type: 'download', ...state.download });
					console.log(`[setup] model downloaded (${result.sizeBytes} bytes)`);
					await startSidecar();
				})
				.catch((error) => {
					state.download = { state: 'error', percent: 0, error: error.message };
					broadcast({ type: 'download', ...state.download });
					console.error(`[setup] download failed: ${error.message}`);
				});
				sendJson(res, 200, { started: true });
			});
			return;
		}

		if (req.method === 'POST' && pathname === '/api/chat') {
			let body = '';
			req.on('data', (chunk) => (body += chunk));
			req.on('end', async () => {
				try {
					const parsed = JSON.parse(body || '{}');
					const reply = await handleChat(parsed.message ?? '');
					sendJson(res, 200, { reply });
				} catch (error) {
					sendJson(res, 500, { error: error.message });
				}
			});
			return;
		}

		if (pathname === '/api/chat') {
			sendJson(res, 405, { error: 'method not allowed' });
			return;
		}

		serveStatic(req, res, pathname);
	});

	async function handleChat(message) {
		if (!state.agent) {
			const status = await triggerSetupCheck();
			if (!status.mixingStation.ok) throw new Error('Mixing Station is not reachable — enable the HTTP REST API on port 8080');
			if (!status.llamaServer.ok) throw new Error('llama-server is not ready yet — check the model file');
			throw new Error('agent not ready');
		}
		const reply = await state.agent.chat(message, { onEvent: (event) => broadcast({ type: 'event', ...event }) });
		return reply;
	}

	server.on('upgrade', (req, socket, head) => {
		const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
		if (url.pathname !== '/api/chat') {
			socket.destroy();
			return;
		}
		wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
	});

	wss.on('connection', (ws) => {
		ws.on('message', async (data) => {
			let parsed;
			try {
				parsed = JSON.parse(data.toString());
			} catch {
				ws.send(JSON.stringify({ type: 'error', message: 'invalid JSON' }));
				return;
			}
			if (parsed.type !== 'chat' || typeof parsed.message !== 'string') return;
			try {
				const reply = await handleChat(parsed.message);
				ws.send(JSON.stringify({ type: 'reply', content: reply }));
			} catch (error) {
				ws.send(JSON.stringify({ type: 'error', message: error.message }));
			}
		});
	});

	// ---- lifecycle ----
	let shuttingDown = false;
	const shutdown = (signal) => {
		if (shuttingDown) return;
		shuttingDown = true;
		state.shuttingDown = true;
		console.log(`[server] received ${signal}, shutting down…`);
		if (state.llama) stopLlama(state.llama.child);
		state.client?.close();
		wss.close();
		server.close(() => process.exit(0));
		setTimeout(() => process.exit(0), 2000);
	};
	process.on('SIGINT', () => shutdown('SIGINT'));
	process.on('SIGTERM', () => shutdown('SIGTERM'));

	server.listen(config.webPort, () => {
		console.log(`[server] Mixing Station Copilot listening on http://localhost:${config.webPort}`);
	});

	await connectMixingStation();
	await startSidecar();
}

main().catch((error) => {
	console.error(`[server] fatal: ${error.message}`);
	process.exit(1);
});
