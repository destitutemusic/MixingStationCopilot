const DEFAULT_CONCURRENCY = 10;
const PROBE_GROUPS = [
    { group: 'channels', prefix: 'ch', count: 16, label: 'Channel' },
    { group: 'buses', prefix: 'bus', count: 8, label: 'Bus' },
    { group: 'dcas', prefix: 'dca', count: 8, label: 'DCA' },
];
const PROBE_KEYS = ['mix.lvl', 'mix.on', 'mix.pan', 'preamp.filter.0.on', 'preamp.filter.0.freq', 'peq.on'];
function labelForKey(key) {
    if (key === 'mix.lvl')
        return 'Fader';
    if (key === 'mix.on')
        return 'Mute';
    if (key === 'mix.pan')
        return 'Pan';
    if (key === 'preamp.filter.0.on')
        return 'HP Filter Enable';
    if (key === 'preamp.filter.0.freq')
        return 'HP Filter Frequency';
    if (key === 'peq.on')
        return 'EQ Enable';
    return key;
}
function unitForKey(key) {
    if (key === 'mix.lvl')
        return 'dB';
    if (key === 'mix.pan')
        return '%';
    if (key === 'preamp.filter.0.freq')
        return 'Hz';
    return undefined;
}
/**
 * Classifies a probe reply. Fader/pan paths are always floats: a fader reading
 * exactly -5 (an integer in JSON) must not pin the generated tool schema to
 * integers, or later fractional writes would be rejected. Unknown keys fall
 * back to value inspection.
 */
function typeForKeyValue(key, value) {
    if (key === 'mix.on' || key === 'preamp.filter.0.on' || key === 'peq.on')
        return 'bool';
    if (key === 'mix.lvl' || key === 'mix.pan' || key === 'preamp.filter.0.freq')
        return 'float';
    if (typeof value === 'boolean')
        return 'bool';
    if (typeof value === 'number')
        return Number.isInteger(value) ? 'int' : 'float';
    if (typeof value === 'string')
        return 'string';
    return 'float';
}
/**
 * Discovers what the connected mixer actually has by GETting key parameters
 * (fader, mute, pan) on candidate channel/bus/DCA paths. Mixing Station
 * answers a GET on an unknown path with an error, so a successful reply means
 * the parameter exists. Probes run with bounded concurrency and preserve
 * probe order in the result.
 */
export class ParameterDiscovery {
    client;
    constructor(client) {
        this.client = client;
    }
    async discover(concurrency = DEFAULT_CONCURRENCY) {
        if (!this.client.connected) {
            throw new Error('Mixing Station client is not connected — call connect() before discovering parameters');
        }
        const probes = [];
        for (const group of PROBE_GROUPS) {
            for (let index = 0; index < group.count; index += 1) {
                for (const key of PROBE_KEYS) {
                    probes.push({ path: `${group.prefix}.${index}.${key}`, group, index, key });
                }
            }
        }
        const results = new Array(probes.length);
        let cursor = 0;
        const workers = Array.from({ length: Math.min(concurrency, probes.length) }, async () => {
            while (cursor < probes.length) {
                const slot = cursor;
                cursor += 1;
                results[slot] = await this.probe(probes[slot]);
            }
        });
        await Promise.all(workers);
        return results.filter((parameter) => parameter !== undefined);
    }
    async probe(probe) {
        try {
            const value = await this.client.get(probe.path);
            return {
                path: probe.path,
                type: typeForKeyValue(probe.key, value),
                label: `${probe.group.label} ${probe.index + 1} ${labelForKey(probe.key)}`,
                unit: unitForKey(probe.key),
                group: probe.group.group,
                canGet: true,
                canSet: true,
            };
        }
        catch {
            // An error reply means the path does not exist on this mixer.
            return undefined;
        }
    }
}
//# sourceMappingURL=discovery.js.map