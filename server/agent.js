import { createMsMcpServer } from '../vendor/msmcp/msmcp-server.js';

const MAX_ITERATIONS = 10;

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
		const res = await fetch(`${llamaBaseUrl}/v1/chat/completions`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: 'functionary-small',
				messages,
				tools,
				tool_choice: 'auto',
				temperature: 0.2,
				max_tokens: 1024,
			}),
		});
		if (!res.ok) {
			const body = await res.text();
			throw new Error(`llama-server chat error: HTTP ${res.status} — ${body.slice(0, 300)}`);
		}
		const data = await res.json();
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

	async function chat(userMessage, { history = [] } = {}) {
		// Serialize chats: llama-server is a single model instance.
		const run = chain.then(async () => {
			const messages = [{ role: 'system', content: systemPrompt }, ...history, { role: 'user', content: userMessage }];
			for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {
				const message = await complete(messages);
				if (!message) throw new Error('llama-server returned an empty response');
				const toolCalls = message.tool_calls ?? [];
				if (toolCalls.length === 0) {
					return message.content ?? '';
				}
				messages.push({ role: 'assistant', content: message.content ?? null, tool_calls: toolCalls });
				for (const call of toolCalls) {
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
