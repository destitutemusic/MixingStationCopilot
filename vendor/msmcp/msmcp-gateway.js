/**
 * Command adapter between MCP tools and Mixing Station. A thin, typed wrapper
 * around MixingStationClient that also carries the discovered parameter
 * catalog so tools can validate paths up front.
 */
export class MsMcpGateway {
    client;
    parameters;
    constructor(client, parameters) {
        this.client = client;
        this.parameters = parameters;
    }
    getParameters() {
        return this.parameters;
    }
    getParameter(path) {
        return this.parameters.find((parameter) => parameter.path === path);
    }
    get connected() {
        return this.client.connected;
    }
    get url() {
        return this.client.url;
    }
    async get(path) {
        const value = await this.client.get(path);
        return { path, value };
    }
    async set(path, value) {
        await this.client.set(path, value);
        return { path, value, sent: true };
    }
    subscribe(path, handler) {
        return this.client.subscribe(path, handler);
    }
    unsubscribe(path) {
        this.client.unsubscribe(path);
    }
    /** Sets values sequentially; a failed call is reported as `sent: false`, not fatal. */
    async batch(calls) {
        const results = [];
        for (const call of calls) {
            try {
                await this.client.set(call.path, call.value);
                results.push({ path: call.path, value: call.value, sent: true });
            }
            catch {
                results.push({ path: call.path, value: call.value, sent: false });
            }
        }
        return results;
    }
    /** Lists Mixing Station scenes; the scene index is the position in the returned array. */
    async listScenes() {
        const body = await this.client.get('scene.list');
        const names = Array.isArray(body) ? body : [];
        return names.map((name, index) => ({ index, name: String(name) }));
    }
    /** Reads the currently active scene index. */
    async getCurrentScene() {
        const index = await this.client.get('scene.current');
        if (typeof index !== 'number' || !Number.isInteger(index)) {
            throw new Error(`Mixing Station scene.current returned an invalid index: ${String(index)}`);
        }
        return { index };
    }
    /** Recalls a scene by index; the mixer applies the change asynchronously. */
    async recallScene(index) {
        await this.client.set('scene.recall', { index });
        return { index, recalled: true };
    }
    async close() {
        this.client.close();
    }
}
//# sourceMappingURL=msmcp-gateway.js.map