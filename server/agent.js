import { request as httpRequest } from 'node:http';
import { createMsMcpServer } from '../vendor/msmcp/msmcp-server.js';

const MAX_ITERATIONS = 10;
// This host is slow (2 cores, ~1s/token prompt eval): a full system prompt +
// tools can take several minutes just to reach the first token. undici's
// default 300s header timeout would abort every long generation, so use a
// raw http request with a generous timeout instead of fetch().
const LLAMA_REQUEST_TIMEOUT_MS = 2.5 * 60 * 60 * 1000;

/** POST a JSON body to the llama-server endpoint, returning parsed JSON. */
function llamaRequest(baseUrl, path, body, timeoutMs = LLAMA_REQUEST_TIMEOUT_MS) {
	return new Promise((resolve, reject) => {
		const url = new URL(path, baseUrl);
		const payload = JSON.stringify(body);
		const req = httpRequest(
			{
				hostname: url.hostname,
				port: url.port,
				path: url.pathname,
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
				timeout: timeoutMs,
			},
			(res) => {
				const chunks = [];
				res.on('data', (chunk) => chunks.push(chunk));
				res.on('end', () => {
					const text = Buffer.concat(chunks).toString('utf8');
					if (res.statusCode !== 200) {
						reject(new Error(`llama-server chat error: HTTP ${res.statusCode} — ${text.slice(0, 300)}`));
						return;
					}
					try {
						resolve(JSON.parse(text));
					} catch (error) {
						reject(new Error(`llama-server returned invalid JSON: ${text.slice(0, 300)}`));
					}
				});
			}
		);
		req.on('timeout', () => req.destroy(new Error(`llama-server request timed out after ${timeoutMs}ms`)));
		req.on('error', reject);
		req.end(payload);
	});
}

// Generic tools exposed to the LLM. MsMcp also registers one get/set tool per
// discovered parameter (dozens on a real mixer); a small local model cannot
// fit that many tool definitions in its context window, so the LLM talks to
// the mixer through the generic tools and the parameter list injected into
// the system prompt (see buildSystemPrompt).
const GENERIC_TOOL_NAMES = new Set([
	'mixer.list_parameters',
	'mixer.get',
	'mixer.set',
	'mixer.batch',
	'mixer.scene.list',
	'mixer.scene.get_current',
	'mixer.scene.recall',
]);

function systemPromptFor(parameters) {
	const lines = [
		"You are Mixing Station Copilot, a mixer assistant. You control the mixer through tool calls.",
		"After making a change, announce what you did in plain language (e.g. \"I've set channel 3's fader to -5 dB\").",
		"Confirm before destructive bulk actions.",
		"",
		"Available parameter paths:",
	];
	for (const p of parameters) {
		const unit = p.unit ? ` ${p.unit}` : '';
		lines.push(`  ${p.path} — ${p.label} (${p.type}${unit})`);
	}
	lines.push("");
	lines.push("Semantics: mix.on == true means the channel is AUDIBLE (not muted). To mute a channel, set its mix.on to false.");
	lines.push("Faders (mix.lvl) are in dB. Channel numbering starts at 0 (ch.0 = channel 1).");
	lines.push("");
	lines.push('EXAMPLES — always respond with a real tool call, never write tool calls as text:');
	lines.push('User: "mute channel 3" -> call mixer.set with {"path": "ch.2.mix.on", "value": false}');
	lines.push('User: "unmute channel 3" -> call mixer.set with {"path": "ch.2.mix.on", "value": true}');
	lines.push('User: "set channel 1 fader to -10" -> call mixer.set with {"path": "ch.0.mix.lvl", "value": -10}');
	lines.push('User: "set channels 1 to 8 faders to 0" -> use mixer.batch with calls [{"path":"ch.0.mix.lvl","value":0},{"path":"ch.1.mix.lvl","value":0}, ... for ch.2..ch.7]');
	lines.push('User: "what is the level on channel 1" -> call mixer.get with {"path": "ch.0.mix.lvl"} then answer with the value');
	lines.push('User: "which channels are muted" -> use mixer.list_parameters first, then mixer.get on each ch.N.mix.on');
	lines.push('Rules: channel numbering starts at 0 (ch.0 = channel 1). Faders are dB values between -90 and 10.');
	return lines.join("\n");
}

/** Build the OpenAI-compatible tool list from MsMcp's registered tool definitions. */
function buildTools(registeredTools) {
	const tools = [];
	for (const name of GENERIC_TOOL_NAMES) {
		const tool = registeredTools[name];
		if (!tool) continue;
		let parameters = { type: 'object' };
		if (typeof tool.inputSchema?.toJSONSchema === 'function') {
			const schema = tool.inputSchema.toJSONSchema();
			delete schema.$schema; // OpenAI rejects unknown top-level keys
			parameters = schema;
		}
		tools.push({ type: 'function', function: { name, description: tool.description, parameters } });
	}
	return tools;
}

function toolResultText(result) {
	try {
		return result.content?.[0]?.text ?? JSON.stringify(result);
	} catch {
		return String(result);
	}
}

export async function createAgent({ gateway, llamaBaseUrl, onEvent = () => {} }) {
	// MsMcp is the single source of truth for both tool schemas and handlers.
	const mcpServer = createMsMcpServer(gateway);
	const registeredTools = mcpServer._registeredTools ?? {};
	const tools = buildTools(registeredTools);
	const systemPrompt = systemPromptFor(gateway.getParameters());

	let chain = Promise.resolve();

	async function complete(messages) {
		const data = await llamaRequest(llamaBaseUrl, '/v1/chat/completions', {
			model: 'local-model',
			messages,
			tools,
			tool_choice: 'auto',
			temperature: 0.2,
			max_tokens: 1024,
		});
		return data.choices?.[0]?.message;
	}

	async function executeTool(name, args) {
		const tool = registeredTools[name];
		if (!tool) {
			return JSON.stringify({ error: `unknown tool: ${name}` });
		}
		try {
			const result = await tool.handler(args);
			const text = toolResultText(result);
			onEvent({ type: 'tool', name, args, result: text });
			return text;
		} catch (error) {
			const text = JSON.stringify({ error: error.message });
			onEvent({ type: 'tool', name, args, result: text, failed: true });
			return text;
		}
	}

	/**
	 * Parse tool calls from model text output as a fallback when the model emits
	 * tool calls as text content (e.g. Hermes 3's <tool_call> format)
	 * instead of native tool_calls objects. Returns an array of parsed calls
	 * in the same shape as OpenAI's tool_calls format.
	 */
	function parseTextToolCalls(content) {
		if (!content || typeof content !== 'string') return [];
		const calls = [];
		// Hermes 3 format: <tool_call>{"name": "...", "arguments": {...}}</tool_call>
		const hermes3Re = /<tool_call>\s*(\{[^<]+?\})\s*<\/tool_call>/gi;
		let m;
		while ((m = hermes3Re.exec(content)) !== null) {
			try {
				const obj = JSON.parse(m[1]);
				const name = obj.name ?? obj.function?.name;
				const args = obj.arguments ?? obj.function?.arguments ?? {};
				if (name) calls.push({ id: `text_call_${calls.length}`, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } });
			} catch {}
		}
		if (calls.length > 0) return calls;
		// Hermes 2 / Functionary text format: <tool_call>\nfunction_name\n{json_args}\n</tool_call>
		const hermes2Re = /<tool_call>\s*\n?([^\n<]+)\n?(\{[^<]+?\})\s*<\/tool_call>/gi;
		while ((m = hermes2Re.exec(content)) !== null) {
			try {
				const name = m[1].trim();
				const args = JSON.parse(m[2]);
				if (name) calls.push({ id: `text_call_${calls.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
			} catch {}
		}
		if (calls.length > 0) return calls;
		// Qwen text format: <tool_call>name\n{arguments json}\n</tool_call>
		const qwenRe = /<tool_call>\s*\n?([a-zA-Z0-9_.]+)\n?(\{[^<]+?\})\s*<\/tool_call>/gi;
		while ((m = qwenRe.exec(content)) !== null) {
			try {
				const name = m[1].trim();
				const obj = JSON.parse(m[2]);
				const args = obj.arguments ?? obj;
				calls.push({ id: `text_call_${calls.length}`, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } });
			} catch {}
		}
		return calls;
	}

	async function chat(userMessage, { history = [] } = {}) {
		// Serialize chats: llama-server is a single model instance.
		const run = chain.then(async () => {
			const messages = [{ role: 'system', content: systemPrompt }, ...history, { role: 'user', content: userMessage }];
			for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {
				const message = await complete(messages);
				if (!message) throw new Error('llama-server returned an empty response');
				const toolCalls = message.tool_calls ?? [];
				// Fallback: if model emitted tool calls as text content (Hermes, Qwen),
				// parse them out rather than returning the raw text.
				if (toolCalls.length === 0 && message.content) {
					const textCalls = parseTextToolCalls(message.content);
					if (textCalls.length > 0) {
						// Re-enter the loop with the parsed calls
						message.tool_calls = textCalls;
						message.content = null;
					}
				}
				const finalToolCalls = message.tool_calls ?? [];
				if (finalToolCalls.length === 0) {
					return message.content ?? '';
				}
				messages.push({ role: 'assistant', content: message.content ?? null, tool_calls: finalToolCalls });
				for (const call of finalToolCalls) {
					let args = {};
					try {
						args = JSON.parse(call.function?.arguments ?? '{}');
					} catch {
						args = { _error: 'malformed tool arguments' };
					}
					const result = await executeTool(call.function?.name, args);
					messages.push({ role: 'tool', tool_call_id: call.id, content: result });
				}
			}
			throw new Error(`agent loop exceeded ${MAX_ITERATIONS} iterations`);
		});
		chain = run.catch(() => {});
		return run;
	}

	return { chat, systemPrompt, tools };
}
