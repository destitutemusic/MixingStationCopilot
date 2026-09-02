import { request as httpRequest } from 'node:http';
import { createMsMcpServer } from '../vendor/msmcp/msmcp-server.js';

const MAX_ITERATIONS = 10;
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

function toolResultText(result) {
	try {
		return result.content?.[0]?.text ?? JSON.stringify(result);
	} catch {
		return String(result);
	}
}

// ---------------------------------------------------------------------------
// TEXT-BASED TOOL CALLING (works with small models that don't support the
// OpenAI `tools` parameter). The model outputs commands in a structured
// text format; we parse them from the response.
// ---------------------------------------------------------------------------

const TOOL_CALL_PATTERN = /TOOL_CALL:\s*(\S+)\s*\nARGS:\s*(\{[^}]*\})/gi;

/**
 * Parse structured tool calls from model text output.
 * The model is instructed to output:
 *   TOOL_CALL: tool_name
 *   ARGS: {"key": "value"}
 */
function parseToolCalls(text) {
	if (!text || typeof text !== 'string') return [];
	const calls = [];
	let m;
	const re = new RegExp(TOOL_CALL_PATTERN.source, 'gi');
	while ((m = re.exec(text)) !== null) {
		try {
			const name = m[1].trim();
			const args = JSON.parse(m[2]);
			calls.push({ id: `text_call_${calls.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
		} catch {}
	}
	if (calls.length > 0) return calls;
	// Truncated JSON repair: if content has TOOL_CALL + ARGS but JSON was cut off
	// by max_tokens, try to close the brackets and parse what we can.
	const truncatedMatch = text.match(/TOOL_CALL:\s*(\S+)\s*\nARGS:\s*(\{.*)/is);
	if (truncatedMatch) {
		const name = truncatedMatch[1].trim();
		let jsonStr = truncatedMatch[2];
		// Close any open brackets/braces
		const opens = (jsonStr.match(/{/g) || []).length;
		const closes = (jsonStr.match(/}/g) || []).length;
		const arrOpens = (jsonStr.match(/\[/g) || []).length;
		const arrCloses = (jsonStr.match(/]/g) || []).length;
		jsonStr += ']'.repeat(Math.max(0, arrOpens - arrCloses));
		jsonStr += '}'.repeat(Math.max(0, opens - closes));
		try {
			const args = JSON.parse(jsonStr);
			calls.push({ id: `text_call_0`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
		} catch {}
	}
	return calls;
}

// ---------------------------------------------------------------------------
// SYSTEM PROMPT — plain text, no OpenAI tools format. Small models understand
// this better.
// ---------------------------------------------------------------------------

function systemPromptFor(parameters) {
	const lines = [
		"You are Mixing Station Copilot, a mixer assistant. You control a real mixing console through tool calls.",
		"",
		"## How to call tools",
		"When you need to call a tool, respond with EXACTLY this format:",
		"",
		"TOOL_CALL: tool_name",
		"ARGS: {\"arg\": \"value\"}",
		"",
		"You MUST call a tool to make changes. NEVER say you did something without calling a tool.",
		"After a tool returns a result, tell the user what happened in plain language.",
		"",
		"## Available tools",
		"",
		"mixer.set — Set a parameter value",
		"  ARGS: {\"path\": \"parameter_path\", \"value\": the_value}",
		"  Example: TOOL_CALL: mixer.set",
		"  ARGS: {\"path\": \"ch.0.mix.on\", \"value\": false}",
		"",
		"mixer.get — Read a parameter value",
		"  ARGS: {\"path\": \"parameter_path\"}",
		"  Example: TOOL_CALL: mixer.get",
		"  ARGS: {\"path\": \"ch.0.mix.lvl\"}",
		"",
		"mixer.batch — Set up to 128 parameters at once",
		"  ARGS: {\"calls\": [{\"path\": \"ch.0.mix.lvl\", \"value\": 0}, ...]}",
		"",
		"mixer.list_parameters — List all available parameters (call this if unsure about paths)",
		"  ARGS: {}",
		"",
		"## Parameter paths (channel numbering starts at 0: ch.0 = channel 1)",
		"",
	];
	for (const p of parameters) {
		const unit = p.unit ? ` (${p.unit})` : '';
		lines.push(`  ${p.path} — ${p.label} (${p.type}${unit})`);
	}
	lines.push("");
	lines.push("## Semantics");
	lines.push("CRITICAL: Channel numbering is 0-indexed. 'Channel 1' = ch.0, 'Channel 2' = ch.1, 'Channel 3' = ch.2. Subtract 1 from the user's channel number.");
	lines.push("mix.on == true means the channel is AUDIBLE (not muted). To mute, set mix.on to false.");
	lines.push("Faders (mix.lvl) are in dB, range -90 to 10.");
	lines.push("Sends (mix.sends.N.lvl) are bus send levels in dB, range -90 to 10. Send 0 = Bus 1, Send 1 = Bus 2, etc.");
	lines.push("Dynamics (dyn.on) enables compressor. EQ (peq.on) enables parametric EQ.");
	lines.push("Channel names (cfg.name) are strings. Colors (cfg.color) are numbers (0=black, 1=red, 2=green, 3=yellow, 4=blue, 5=magenta, 6=cyan, 7=white).");
	lines.push("");
	lines.push("## Examples");
	lines.push("");
	lines.push('User: "mute channel 3" ->');
	lines.push('TOOL_CALL: mixer.set');
	lines.push('ARGS: {"path": "ch.2.mix.on", "value": false}');
	lines.push("");
	lines.push('User: "unmute channel 3" ->');
	lines.push('TOOL_CALL: mixer.set');
	lines.push('ARGS: {"path": "ch.2.mix.on", "value": true}');
	lines.push("");
	lines.push('User: "set channel 1 fader to -10" ->');
	lines.push('TOOL_CALL: mixer.set');
	lines.push('ARGS: {"path": "ch.0.mix.lvl", "value": -10}');
	lines.push("");
	lines.push('User: "what is the level on channel 1" ->');
	lines.push('TOOL_CALL: mixer.get');
	lines.push('ARGS: {"path": "ch.0.mix.lvl"}');
	lines.push("");
	lines.push('User: "set channels 1 to 8 faders to 0" ->');
	lines.push('TOOL_CALL: mixer.batch');
	lines.push('ARGS: {"calls": [{"path":"ch.0.mix.lvl","value":0},{"path":"ch.1.mix.lvl","value":0},{"path":"ch.2.mix.lvl","value":0},{"path":"ch.3.mix.lvl","value":0},{"path":"ch.4.mix.lvl","value":0},{"path":"ch.5.mix.lvl","value":0},{"path":"ch.6.mix.lvl","value":0},{"path":"ch.7.mix.lvl","value":0}]}');
	lines.push("");
	lines.push('User: "rename channel 1 to Kick" ->');
	lines.push('TOOL_CALL: mixer.set');
	lines.push('ARGS: {"path": "ch.0.cfg.name", "value": "Kick"}');
	lines.push("");
	lines.push('User: "set channel 1 color to blue" ->');
	lines.push('TOOL_CALL: mixer.set');
	lines.push('ARGS: {"path": "ch.0.cfg.color", "value": 4}');
	lines.push("");
	lines.push('User: "enable high pass filter on channel 1 at 100hz" ->');
	lines.push('TOOL_CALL: mixer.set');
	lines.push('ARGS: {"path": "ch.0.preamp.filter.0.on", "value": true}');
	lines.push('TOOL_CALL: mixer.set');
	lines.push('ARGS: {"path": "ch.0.preamp.filter.0.freq", "value": 100}');
	lines.push("");
	lines.push('User: "turn on compressor on channel 1" ->');
	lines.push('TOOL_CALL: mixer.set');
	lines.push('ARGS: {"path": "ch.0.dyn.on", "value": true}');
	lines.push("");
	lines.push('User: "set send 1 level on channel 1 to -10" ->');
	lines.push('TOOL_CALL: mixer.set');
	lines.push('ARGS: {"path": "ch.0.mix.sends.0.lvl", "value": -10}');
	lines.push("");
	lines.push('User: "enable EQ on channel 1" ->');
	lines.push('TOOL_CALL: mixer.set');
	lines.push('ARGS: {"path": "ch.0.peq.on", "value": true}');
	lines.push("");
	lines.push('User: "what is the name of channel 1" ->');
	lines.push('TOOL_CALL: mixer.get');
	lines.push('ARGS: {"path": "ch.0.cfg.name"}');
	lines.push("");
	lines.push('User: "mute channels 1 through 4" ->');
	lines.push('TOOL_CALL: mixer.batch');
	lines.push('ARGS: {"calls": [{"path":"ch.0.mix.on","value":false},{"path":"ch.1.mix.on","value":false},{"path":"ch.2.mix.on","value":false},{"path":"ch.3.mix.on","value":false}]}');
	return lines.join("\n");
}

async function executeTool(name, args, registeredTools, onEvent) {
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

export async function createAgent({ gateway, llamaBaseUrl, onEvent = () => {} }) {
	const mcpServer = createMsMcpServer(gateway);
	const registeredTools = mcpServer._registeredTools ?? {};
	const systemPrompt = systemPromptFor(gateway.getParameters());

	let chain = Promise.resolve();

	async function chat(userMessage, { history = [] } = {}) {
		const run = chain.then(async () => {
			const messages = [{ role: 'system', content: systemPrompt }, ...history, { role: 'user', content: userMessage }];

			for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {
				// Send to llama-server — NO tools parameter, just messages
				const data = await llamaRequest(llamaBaseUrl, '/v1/chat/completions', {
					model: 'local-model',
					messages,
					temperature: 0.2,
					max_tokens: 1024,
				});

				const content = data.choices?.[0]?.message?.content ?? '';
				console.log('[agent] model output:', JSON.stringify(content.slice(0, 400)));
				console.log('[agent] has newlines:', content.includes('\n'));

				// Parse tool calls from text
				const toolCalls = parseToolCalls(content);

				if (toolCalls.length === 0) {
					console.log('[agent] no tool calls, returning text');
					return content;
				}

				// Execute tool calls
				console.log(`[agent] executing ${toolCalls.length} tool call(s)`);
				messages.push({ role: 'assistant', content });
				for (const call of toolCalls) {
					let args = {};
					try {
						args = JSON.parse(call.function?.arguments ?? '{}');
					} catch {
						args = { _error: 'malformed tool arguments' };
					}
					const result = await executeTool(call.function?.name, args, registeredTools, onEvent);
					console.log(`[agent] tool ${call.function?.name}(${JSON.stringify(args)}) => ${result?.slice(0, 200)}`);
					messages.push({ role: 'user', content: `Tool result for ${call.function?.name}:\n${result}` });
				}
				// Continue loop so model can read the tool result and respond
			}
			return 'I made too many tool calls. Please try again.';
		});
		chain = run.catch(() => {});
		return run;
	}

	return { chat, systemPrompt, tools: [] };
}
