import WebSocket from 'ws';
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 1234;
export const DEFAULT_TIMEOUT_MS = 5_000;
export const DEFAULT_RECONNECT_DELAY_MS = 1_000;
export const DEFAULT_MAX_RECONNECT_DELAY_MS = 10_000;
/** Strip a leading '/', 'console/data/' prefix and whitespace from a parameter path. */
function normalizePattern(pattern) {
    let path = pattern.trim();
    while (path.startsWith('/'))
        path = path.slice(1);
    if (path.startsWith('console/data/'))
        path = path.slice('console/data/'.length);
    return path;
}
function normalizeDataPath(dataPath) {
    let path = dataPath.trim();
    while (path.startsWith('/'))
        path = path.slice(1);
    return path;
}
/** Compile a Mixing Station path pattern (`ch.*.mix.lvl`) to a regex over bare data paths. */
function wildcardToRegex(pattern) {
    let source = '^';
    for (const character of pattern) {
        if (character === '*')
            source += '.*';
        else
            source += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    source += '$';
    return new RegExp(source);
}
/**
 * Client for Mixing Station Desktop's REST/websocket API.
 *
 *   GET:  HTTP GET  /console/data/get/<path>/val → { "format": "val", "value": <value> }
 *   SET:  HTTP POST /console/data/set/<path>/val, body { "value": <value> } → { "format": "val", "value": <value> }
 *   subscribe: WebSocket POST /console/data/subscribe with body { "path": "ch.*.mix.lvl", "format": "val" }
 *   paths: WebSocket GET /console/data/paths;  info: WebSocket GET /console/information
 *
 * GET/SET go over HTTP REST. The websocket is used for subscriptions — updates
 * arrive on `/console/data/<concrete-path>` and are dispatched to every
 * subscribed pattern that matches — and for parameter tree discovery.
 *
 * The websocket request protocol has no request ids — responses echo `method` +
 * `path`, so pending requests are correlated by `${method} ${path}` (FIFO per
 * key; concurrent requests to the same path resolve in send order).
 *
 * The websocket reconnects automatically with capped exponential backoff after
 * a successful connection drops; active subscriptions are re-established on
 * reconnect. A failed initial connect() rejects and does not retry in the
 * background — call connect() again when Mixing Station is reachable.
 */
export class MixingStationClient {
    host;
    port;
    timeoutMs;
    reconnectDelayMs;
    maxReconnectDelayMs;
    onReconnect;
    onDisconnect;
    socket;
    connecting;
    rejectConnecting;
    lastError;
    closed = false;
    hasConnectedOnce = false;
    ready = false;
    reconnectAttempts = 0;
    reconnectTimer;
    /** Pending requests keyed by `${method} ${path}`, FIFO per key. */
    pending = new Map();
    subscriptions = new Map();
    /** Resolvers waiting for the first update of a subscription handshake. */
    firstUpdates = new Map();
    constructor(options = {}) {
        this.host = options.host ?? DEFAULT_HOST;
        this.port = options.port ?? DEFAULT_PORT;
        this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        this.reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
        this.maxReconnectDelayMs = options.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS;
        this.onReconnect = options.onReconnect;
        this.onDisconnect = options.onDisconnect;
    }
    get url() {
        return `ws://${this.host}:${this.port}`;
    }
    get connected() {
        return this.socket?.readyState === WebSocket.OPEN;
    }
    /** Open the websocket and verify HTTP connectivity. Resolves when both succeed; rejects on failure. */
    async connect() {
        await this.openSocket();
        await this.verifyHttp();
        this.ready = true;
    }
    /** Read a parameter value over HTTP REST. Resolves with the response `value`. */
    async get(dataPath) {
        this.requireReady();
        return this.httpGet(dataPath);
    }
    /** Write a parameter value over HTTP REST. Resolves with the response `value`. */
    async set(dataPath, value) {
        this.requireReady();
        return this.httpPost(dataPath, value);
    }
    /**
     * Subscribe to a parameter path pattern. Resolves once the subscription is
     * active (server ack or the initial value update), rejects on error or timeout.
     * A re-subscribe to the same pattern replaces the handler.
     */
    subscribe(path, handler, format = 'val') {
        const pattern = normalizePattern(path);
        this.subscriptions.set(pattern, { path: pattern, format, handler });
        return new Promise((resolve, reject) => {
            let settled = false;
            const timer = setTimeout(() => settle(new Error(`Mixing Station subscribe '${pattern}' timed out after ${this.timeoutMs}ms`)), this.timeoutMs);
            const cleanup = () => {
                const resolvers = this.firstUpdates.get(pattern);
                if (resolvers) {
                    const index = resolvers.indexOf(settleFirst);
                    if (index !== -1)
                        resolvers.splice(index, 1);
                    if (resolvers.length === 0)
                        this.firstUpdates.delete(pattern);
                }
                clearTimeout(timer);
            };
            const settle = (error) => {
                if (settled)
                    return;
                settled = true;
                cleanup();
                if (error)
                    reject(error);
                else
                    resolve();
            };
            const settleFirst = () => settle();
            let resolvers = this.firstUpdates.get(pattern);
            if (!resolvers) {
                resolvers = [];
                this.firstUpdates.set(pattern, resolvers);
            }
            resolvers.push(settleFirst);
            this.sendRequest({ method: 'POST', path: '/console/data/subscribe', body: { path: pattern, format } })
                .then(() => settle(), (error) => settle(error instanceof Error ? error : new Error(String(error))));
        });
    }
    /**
     * Stop dispatching updates for a pattern. Local dispatch stops immediately;
     * removal on the server is best-effort (the unsubscribe endpoint is not
     * documented, so no error is raised if Mixing Station ignores it).
     */
    unsubscribe(path) {
        const pattern = normalizePattern(path);
        this.subscriptions.delete(pattern);
        const socket = this.socket;
        if (socket?.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ method: 'POST', path: '/console/data/unsubscribe', body: { path: pattern } }));
        }
    }
    /** Stop the client: close the socket, cancel reconnects, reject pending requests. */
    close() {
        this.closed = true;
        this.ready = false;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = undefined;
        }
        this.failPending(new Error('Mixing Station client closed'));
        this.rejectConnecting?.(new Error('Mixing Station client closed'));
        this.rejectConnecting = undefined;
        const socket = this.socket;
        this.socket = undefined;
        if (socket && socket.readyState !== WebSocket.CLOSED) {
            if (socket.readyState === WebSocket.CONNECTING)
                socket.terminate();
            else
                socket.close();
        }
    }
    openSocket() {
        if (this.socket?.readyState === WebSocket.OPEN)
            return Promise.resolve();
        if (this.connecting)
            return this.connecting;
        this.connecting = new Promise((resolve, reject) => {
            const socket = new WebSocket(`ws://${this.host}:${this.port}`);
            this.socket = socket;
            this.rejectConnecting = reject;
            socket.on('open', () => {
                this.rejectConnecting = undefined;
                this.hasConnectedOnce = true;
                resolve();
            });
            socket.on('message', (data) => this.handleMessage(data));
            socket.on('error', (error) => {
                this.lastError = error instanceof Error ? error : new Error(String(error));
            });
            socket.on('close', () => this.handleClose());
        }).finally(() => {
            this.connecting = undefined;
        });
        return this.connecting;
    }
    handleClose() {
        this.socket = undefined;
        this.rejectConnecting?.(new Error('Mixing Station connection closed'));
        this.rejectConnecting = undefined;
        this.failPending(new Error('Mixing Station connection lost'));
        const error = this.lastError;
        this.lastError = undefined;
        this.onDisconnect?.(error);
        if (this.closed)
            return;
        // Only auto-reconnect after a connection that already succeeded once;
        // a failed initial connect() leaves retrying to the caller.
        if (!this.hasConnectedOnce)
            return;
        this.scheduleReconnect();
    }
    scheduleReconnect() {
        if (this.reconnectTimer || this.closed)
            return;
        const attempt = this.reconnectAttempts;
        this.reconnectAttempts += 1;
        const delay = Math.min(this.reconnectDelayMs * 2 ** attempt, this.maxReconnectDelayMs);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = undefined;
            this.openSocket()
                .then(() => {
                this.reconnectAttempts = 0;
                this.resubscribe();
                this.onReconnect?.();
            })
                .catch(() => {
                // The socket 'close' handler schedules the next attempt.
            });
        }, delay);
    }
    resubscribe() {
        for (const subscription of this.subscriptions.values()) {
            this.sendRequest({ method: 'POST', path: '/console/data/subscribe', body: { path: subscription.path, format: subscription.format } })
                .catch(() => {
                // A failed resubscribe is retried on the next reconnect.
            });
        }
    }
    handleMessage(data) {
        let message;
        try {
            message = JSON.parse(data.toString());
        }
        catch {
            return;
        }
        if (typeof message !== 'object' || message === null || Array.isArray(message))
            return;
        const record = message;
        const { path, method, body, error } = record;
        if (typeof path !== 'string' || typeof method !== 'string')
            return;
        const response = { path, method, body, error: error == null ? null : String(error) };
        const key = `${method} ${path}`;
        const queue = this.pending.get(key);
        if (queue && queue.length > 0) {
            const pending = queue.shift();
            if (queue.length === 0)
                this.pending.delete(key);
            clearTimeout(pending.timer);
            if (response.error !== null) {
                pending.reject(new Error(`Mixing Station request '${key}' failed: ${response.error}`));
            }
            else {
                pending.resolve(response);
            }
            return;
        }
        if (path === '/console/data/subscribe' || path === '/console/data/unsubscribe')
            return;
        if (!path.startsWith('/console/data/'))
            return;
        const dataPath = path.slice('/console/data/'.length);
        for (const subscription of this.subscriptions.values()) {
            if (!wildcardToRegex(subscription.path).test(dataPath))
                continue;
            const resolvers = this.firstUpdates.get(subscription.path);
            if (resolvers && resolvers.length > 0) {
                const settleFirst = resolvers.shift();
                if (resolvers.length === 0)
                    this.firstUpdates.delete(subscription.path);
                settleFirst();
            }
            try {
                subscription.handler(response.body, response);
            }
            catch {
                // A handler error must not break the message loop.
            }
        }
    }
    sendRequest(request) {
        const socket = this.requireSocket();
        const key = `${request.method} ${request.path}`;
        return new Promise((resolve, reject) => {
            const pending = {
                resolve,
                reject,
                timer: setTimeout(() => {
                    const queue = this.pending.get(key);
                    if (queue) {
                        const index = queue.indexOf(pending);
                        if (index !== -1)
                            queue.splice(index, 1);
                        if (queue.length === 0)
                            this.pending.delete(key);
                    }
                    reject(new Error(`Mixing Station request '${key}' timed out after ${this.timeoutMs}ms`));
                }, this.timeoutMs),
            };
            let queue = this.pending.get(key);
            if (!queue) {
                queue = [];
                this.pending.set(key, queue);
            }
            queue.push(pending);
            socket.send(JSON.stringify(request));
        });
    }
    requireSocket() {
        const socket = this.socket;
        if (!socket || socket.readyState !== WebSocket.OPEN) {
            throw new Error('Mixing Station client is not connected — call connect() first');
        }
        return socket;
    }
    failPending(error) {
        for (const queue of this.pending.values()) {
            for (const pending of queue) {
                clearTimeout(pending.timer);
                pending.reject(error);
            }
        }
        this.pending.clear();
    }
    requireReady() {
        if (this.closed || !this.ready) {
            throw new Error('Mixing Station client is not connected — call connect() first');
        }
    }
    async httpGet(dataPath) {
        return this.httpValue('GET', dataPath);
    }
    async httpPost(dataPath, value) {
        return this.httpValue('POST', dataPath, value);
    }
    async httpValue(method, dataPath, value) {
        const action = method === 'GET' ? 'get' : 'set';
        const url = `http://${this.host}:${this.port}/console/data/${action}/${normalizeDataPath(dataPath)}/val`;
        let response;
        try {
            response = await fetch(url, {
                method,
                headers: method === 'POST' ? { 'content-type': 'application/json' } : undefined,
                body: method === 'POST' ? JSON.stringify({ value }) : undefined,
                signal: AbortSignal.timeout(this.timeoutMs),
            });
        }
        catch (error) {
            if (error instanceof Error && error.name === 'TimeoutError') {
                throw new Error(`Mixing Station REST ${method} ${url} timed out after ${this.timeoutMs}ms`);
            }
            const detail = error instanceof Error ? error.message : String(error);
            throw new Error(`Mixing Station REST ${method} ${url} failed: ${detail}`);
        }
        if (!response.ok) {
            throw new Error(`Mixing Station REST ${method} ${url} failed: HTTP ${response.status}`);
        }
        const body = await response.json();
        if (typeof body === 'object' && body !== null && 'value' in body) {
            return body.value;
        }
        return body;
    }
    async verifyHttp() {
        let response;
        try {
            response = await fetch(`http://${this.host}:${this.port}/app/state`, { signal: AbortSignal.timeout(this.timeoutMs) });
        }
        catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            throw new Error(`Mixing Station HTTP connectivity check failed: ${detail}`);
        }
        if (!response.ok) {
            throw new Error(`Mixing Station HTTP connectivity check failed: HTTP ${response.status}`);
        }
    }
}
//# sourceMappingURL=mixingstation.js.map