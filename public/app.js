(() => {
	'use strict';

	const $ = (id) => document.getElementById(id);
	const statusDot = $('statusDot');
	const setupView = $('setupView');
	const chatView = $('chatView');
	const stepsEl = $('steps');
	const messagesEl = $('messages');
	const inputEl = $('chatInput');
	const sendBtn = $('sendBtn');

	let ws = null;
	let busy = false;

	const STEP_LABELS = {
		node: 'Node.js 20+',
		'llama-binary': 'llama-server binary',
		model: 'AI model file',
		mixingStation: 'Mixing Station (:8080)',
		llamaServer: 'Model server (:8090)',
	};

	function setStatus(cls) {
		statusDot.className = cls;
	}

	function addMessage(role, content) {
		const div = document.createElement('div');
		div.className = `msg ${role}`;
		div.textContent = content;
		messagesEl.appendChild(div);
		messagesEl.scrollTop = messagesEl.scrollHeight;
		return div;
	}

	function typingIndicator() {
		const div = document.createElement('div');
		div.className = 'typing';
		div.textContent = 'Copilot is thinking';
		messagesEl.appendChild(div);
		messagesEl.scrollTop = messagesEl.scrollHeight;
		return div;
	}

	function renderSteps(status) {
		const order = ['node', 'llama-binary', 'model', 'mixingStation', 'llamaServer'];
		stepsEl.innerHTML = '';
		for (const key of order) {
			const item = status[key];
			const li = document.createElement('li');
			const ok = Boolean(item && item.ok);
			const pending = key === 'llamaServer' && !ok && !status.ready && status.needs === 'llama-start';
			li.className = ok ? 'ok' : pending ? 'pend' : 'bad';
			const icon = ok ? '\u2713' : pending ? '\u231B' : '\u2717';
			const detail = ok ? 'ready' : item && item.error ? item.error : pending ? 'starting\u2026' : '';
			li.innerHTML = `<span class="ico">${icon}</span><span class="lbl">${STEP_LABELS[key]}</span><span class="det">${escapeHtml(detail)}</span>`;
			stepsEl.appendChild(li);
		}
	}

	function escapeHtml(text) {
		return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
	}

	async function renderModelChoices() {
		const res = await fetch('/api/setup/models');
		const models = await res.json();
		const wrap = document.getElementById('modelChoices');
		wrap.innerHTML = '';
		let selected = null;
		models.forEach((m, i) => {
			const label = document.createElement('label');
			label.className = 'modelChoice';
			const sizeGb = (m.sizeBytes / 1e9).toFixed(1);
			label.innerHTML = `<input type="radio" name="modelChoice" value="${m.id}" ${i === 0 ? 'checked' : ''}>` +
				`<span><span class="mLabel">${m.label}</span>` +
				`<span class="mMeta">~${sizeGb} GB download \u00b7 ${m.ramNote}${m.present ? ' \u00b7 already downloaded' : ''}</span></span>`;
			wrap.appendChild(label);
		});
		wrap.querySelectorAll('input[name=modelChoice]').forEach((input) => {
			input.addEventListener('change', () => {
				selected = input.value;
				const btn = document.getElementById('downloadBtn');
				btn.disabled = false;
				btn.textContent = models.find((m) => m.id === selected).present ? 'Use this model' : 'Download model';
			});
		});
		// default-select first
		selected = models[0].id;
		const btn = document.getElementById('downloadBtn');
		btn.disabled = false;
		btn.textContent = models[0].present ? 'Use this model' : 'Download model';
		window.__selectedModel = () => selected;
	}

	function renderSetup(status) {
		renderSteps(status);
		const needs = status.needs;
		const cardWasHidden = !$('downloadCard').classList.contains('visible');
		$('downloadCard').classList.toggle('visible', needs === 'model');
		if (needs === 'model' && cardWasHidden) renderModelChoices();
		$('msCard').classList.toggle('visible', needs === 'ms');
		$('llamaCard').classList.toggle('visible', needs === 'llama-start');
		if (status.ready) {
			setStatus('ready');
			showChat();
		} else if (needs === 'llama-start') {
			setStatus('pending');
			setTimeout(refreshSetup, 2000);
		} else {
			setStatus(needs ? 'err' : 'pending');
		}
	}

	function showChat() {
		chatView.classList.add('visible');
		setupView.style.display = 'none';
		if (!ws) connectWs();
	}

	async function refreshSetup() {
		try {
			const res = await fetch('/api/setup/check');
			const status = await res.json();
			renderSetup(status);
		} catch {
			setStatus('err');
		}
	}

	async function pollDownload() {
		try {
			const res = await fetch('/api/setup/download');
			const d = await res.json();
			if (d.state === 'downloading') {
				$('progressBar').style.width = `${d.percent || 0}%`;
				$('progressText').textContent = `Downloading\u2026 ${formatBytes(d.received)}${d.total ? ' / ' + formatBytes(d.total) : ''} (${d.percent || 0}%)`;
				setTimeout(pollDownload, 500);
			} else if (d.state === 'done') {
				$('progressBar').style.width = '100%';
				$('progressText').textContent = 'Download complete. Starting model server\u2026';
				$('downloadBtn').disabled = false;
				setTimeout(refreshSetup, 1000);
			} else if (d.state === 'error') {
				$('progressText').textContent = `Download failed: ${d.error}`;
				$('downloadBtn').disabled = false;
			}
		} catch {
			/* transient; next poll will retry */
		}
	}

	function formatBytes(bytes) {
		if (!bytes) return '0 B';
		const units = ['B', 'KB', 'MB', 'GB'];
		let i = 0;
		let n = bytes;
		while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
		return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
	}

	function connectWs() {
		const proto = location.protocol === 'https:' ? 'wss' : 'ws';
		ws = new WebSocket(`${proto}://${location.host}/api/chat`);
		ws.onopen = () => {};
		ws.onmessage = (event) => {
			let msg;
			try { msg = JSON.parse(event.data); } catch { return; }
			if (msg.type === 'reply') {
				busy = false;
				setBusy(false);
				addMessage('assistant', msg.content);
			} else if (msg.type === 'tool') {
				addMessage('tool', `\u2699 tool ${msg.name} ${JSON.stringify(msg.args ?? {})} \u2192 ${String(msg.result ?? '').slice(0, 200)}`);
			} else if (msg.type === 'error') {
				busy = false;
				setBusy(false);
				addMessage('error', msg.message);
			} else if (msg.type === 'download' || msg.type === 'setup') {
				refreshSetup();
			}
		};
		ws.onclose = () => {
			ws = null;
			if (chatView.classList.contains('visible')) setTimeout(connectWs, 2000);
		};
	}

	function setBusy(value) {
		busy = value;
		sendBtn.disabled = value;
		inputEl.disabled = value;
		if (!value) inputEl.focus();
	}

	function send() {
		const text = inputEl.value.trim();
		if (!text || busy || !ws || ws.readyState !== WebSocket.OPEN) return;
		inputEl.value = '';
		addMessage('user', text);
		typingIndicator();
		setBusy(true);
		ws.send(JSON.stringify({ type: 'chat', message: text }));
	}

	$('downloadBtn').addEventListener('click', async () => {
		$('downloadBtn').disabled = true;
		$('progressText').textContent = 'Starting download\u2026';
		const modelId = window.__selectedModel ? window.__selectedModel() : undefined;
		await fetch('/api/setup/download', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ modelId }) });
		pollDownload();
	});

	$('retryBtn').addEventListener('click', () => {
		$('retryBtn').disabled = true;
		refreshSetup().finally(() => { $('retryBtn').disabled = false; });
	});

	sendBtn.addEventListener('click', send);
	inputEl.addEventListener('keydown', (event) => {
		if (event.key === 'Enter') send();
	});

	refreshSetup();
})();
