import dgram from 'node:dgram';
export const MAX_OSC_PACKET_SIZE = 65_507;
function align4(value) {
    return (value + 3) & ~3;
}
function paddedString(value) {
    const raw = Buffer.from(`${value}\0`, 'utf8');
    const result = Buffer.alloc(align4(raw.length));
    raw.copy(result);
    return result;
}
function readPaddedString(packet, offset, end) {
    const terminator = packet.subarray(offset, end).indexOf(0);
    if (terminator < 0)
        throw new Error('unterminated OSC string');
    const stringEnd = offset + terminator;
    const next = align4(stringEnd + 1);
    if (next > end)
        throw new Error('truncated OSC string padding');
    return { value: packet.subarray(offset, stringEnd).toString('utf8'), offset: next };
}
function readU32(packet, offset, end) {
    if (offset < 0 || offset + 4 > end)
        throw new Error('truncated OSC 32-bit value');
    return { value: packet.readUInt32BE(offset), offset: offset + 4 };
}
function encodeArgument(value) {
    switch (value.type) {
        case 'int': {
            const result = Buffer.alloc(4);
            result.writeInt32BE(value.value, 0);
            return result;
        }
        case 'float': {
            const result = Buffer.alloc(4);
            result.writeFloatBE(value.value, 0);
            return result;
        }
        case 'string':
            return paddedString(value.value);
        case 'bool':
        case 'nil':
            return Buffer.alloc(0);
        case 'blob': {
            const header = Buffer.alloc(4);
            header.writeUInt32BE(value.value.byteLength, 0);
            const payload = Buffer.from(value.value);
            return Buffer.concat([header, payload, Buffer.alloc(align4(payload.length) - payload.length)]);
        }
    }
}
function typeTags(values) {
    return `,${values.map((value) => {
        if (value.type === 'int')
            return 'i';
        if (value.type === 'float')
            return 'f';
        if (value.type === 'string')
            return 's';
        if (value.type === 'bool')
            return value.value ? 'T' : 'F';
        if (value.type === 'nil')
            return 'N';
        return 'b';
    }).join('')}`;
}
export function encodeOscMessage(message) {
    if (!message.address.startsWith('/'))
        throw new Error('OSC address must start with /');
    const parts = [paddedString(message.address), paddedString(typeTags(message.arguments)), ...message.arguments.map(encodeArgument)];
    const result = Buffer.concat(parts);
    if (result.length > MAX_OSC_PACKET_SIZE)
        throw new Error('OSC packet exceeds UDP payload limit');
    return result;
}
function decodeElement(packet, offset, end) {
    const address = readPaddedString(packet, offset, end);
    if (address.value === '#bundle') {
        if (address.offset + 8 > end)
            throw new Error('truncated OSC bundle timetag');
        let cursor = address.offset + 8;
        const messages = [];
        while (cursor < end) {
            const size = readU32(packet, cursor, end);
            cursor = size.offset;
            if (size.value === 0 || size.value > end - cursor)
                throw new Error('invalid OSC bundle element size');
            const nested = decodeElement(packet, cursor, cursor + size.value);
            messages.push(...nested.messages);
            cursor += size.value;
        }
        return { messages, offset: cursor };
    }
    const tags = readPaddedString(packet, address.offset, end);
    if (!tags.value.startsWith(','))
        throw new Error('OSC typetag string is missing comma');
    let cursor = tags.offset;
    const values = [];
    for (const tag of tags.value.slice(1)) {
        if (tag === 'i') {
            const value = readU32(packet, cursor, end);
            values.push({ type: 'int', value: value.value | 0 });
            cursor = value.offset;
        }
        else if (tag === 'f') {
            if (cursor + 4 > end)
                throw new Error('truncated OSC float');
            values.push({ type: 'float', value: packet.readFloatBE(cursor) });
            cursor += 4;
        }
        else if (tag === 's') {
            const value = readPaddedString(packet, cursor, end);
            values.push({ type: 'string', value: value.value });
            cursor = value.offset;
        }
        else if (tag === 'T' || tag === 'F') {
            values.push({ type: 'bool', value: tag === 'T' });
        }
        else if (tag === 'N') {
            values.push({ type: 'nil' });
        }
        else if (tag === 'b') {
            const size = readU32(packet, cursor, end);
            cursor = size.offset;
            if (size.value > end - cursor)
                throw new Error('truncated OSC blob');
            const blob = new Uint8Array(packet.subarray(cursor, cursor + size.value));
            cursor += size.value;
            cursor = align4(cursor);
            if (cursor > end)
                throw new Error('truncated OSC blob padding');
            values.push({ type: 'blob', value: blob });
        }
        else {
            throw new Error(`unsupported OSC typetag: ${tag}`);
        }
    }
    return { messages: [{ address: address.value, arguments: values }], offset: cursor };
}
export function decodeOscPacket(packet) {
    const buffer = Buffer.from(packet);
    if (buffer.length === 0 || buffer.length > MAX_OSC_PACKET_SIZE)
        throw new Error('invalid OSC packet size');
    const decoded = decodeElement(buffer, 0, buffer.length);
    if (decoded.offset !== buffer.length)
        throw new Error('trailing bytes in OSC packet');
    return decoded.messages;
}
export class UdpOscTransport {
    host;
    port;
    socket = dgram.createSocket('udp4');
    constructor(host, port) {
        this.host = host;
        this.port = port;
    }
    async send(message) {
        const packet = encodeOscMessage(message);
        await new Promise((resolve, reject) => {
            this.socket.send(packet, this.port, this.host, (error) => error ? reject(error) : resolve());
        });
    }
    async request(message, expectedAddress, timeoutMs) {
        if (timeoutMs < 0)
            throw new Error('OSC timeout must not be negative');
        const packet = encodeOscMessage(message);
        return await new Promise((resolve, reject) => {
            let settled = false;
            const finish = (callback) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                this.socket.off('message', onMessage);
                this.socket.off('error', onError);
                callback();
            };
            const onMessage = (received) => {
                try {
                    const response = decodeOscPacket(received).find((candidate) => candidate.address === expectedAddress);
                    if (response !== undefined)
                        finish(() => resolve(response));
                }
                catch (error) {
                    finish(() => reject(error));
                }
            };
            const onError = (error) => finish(() => reject(error));
            const timer = setTimeout(() => finish(() => resolve(null)), timeoutMs);
            this.socket.on('message', onMessage);
            this.socket.once('error', onError);
            this.socket.send(packet, this.port, this.host, (error) => {
                if (error !== null)
                    finish(() => reject(error));
            });
        });
    }
    close() {
        this.socket.close();
    }
}
//# sourceMappingURL=osc.js.map