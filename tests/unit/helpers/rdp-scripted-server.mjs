// A scripted in-process TCP server for driving the vendored RDP client in unit tests.
// Extracted from rdp-client.test.mjs so both it and rdp-request.test.mjs can share it.

import net from 'node:net';
import { FirefoxRDPClient, parseRDPMessage } from '../../../src/web-ext-rdp.js';

export function frame(message) {
    const json = JSON.stringify(message);
    return `${Buffer.byteLength(json)}:${json}`;
}

/**
 * Start a scripted RDP server. `onRequest(message, reply)` is called for each parsed
 * client request. The returned handle exposes `send`/`sendRaw` (writes to the most
 * recent connection) for unsolicited server-initiated messages, plus `endSocket` and
 * `close`. The root hello is sent automatically on connection.
 */
export async function startScriptedServer(onRequest) {
    let socket = null;
    let buffer = Buffer.alloc(0);
    const server = net.createServer((conn) => {
        socket = conn;
        conn.write(frame({ from: 'root', applicationType: 'browser' }));
        conn.on('data', (data) => {
            buffer = Buffer.concat([buffer, data]);
            while (true) {
                const { data: rest, rdpMessage } = parseRDPMessage(buffer);
                buffer = rest;
                if (!rdpMessage) break;
                onRequest?.(rdpMessage, (reply) => conn.write(frame(reply)));
            }
        });
        conn.on('error', () => {});
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
        port: server.address().port,
        send: (message) => socket.write(frame(message)),
        sendRaw: (raw) => socket.write(raw),
        endSocket: () => socket.end(),
        close: () =>
            new Promise((resolve) => {
                socket?.destroy();
                server.close(resolve);
            }),
    };
}

export async function connectClient(server) {
    const client = new FirefoxRDPClient();
    await client.connect(server.port);
    return client;
}
