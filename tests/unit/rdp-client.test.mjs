// Unit tests for the vendored RDP client, driven against a scripted in-process TCP
// server. These pin the transport behaviours the harness depends on: response
// matching, event-vs-response routing, error-reply wrapping, incremental framing,
// parse-error handling and teardown semantics.

import test from 'node:test';
import assert from 'node:assert/strict';

import { FirefoxRDPClient, parseRDPMessage } from '../../src/web-ext-rdp.js';
import { frame, startScriptedServer, connectClient } from './helpers/rdp-scripted-server.mjs';

test('connect resolves on the root hello and requests match responses by actor', async () => {
    const server = await startScriptedServer((message, reply) => {
        if (message.type === 'echo') {
            reply({ from: message.to, echoed: message.payload });
        }
    });
    const client = await connectClient(server);
    const response = await client.request({ to: 'actor1', type: 'echo', payload: 'hi' });
    assert.equal(response.echoed, 'hi');
    client.disconnect();
    await server.close();
});

test('a known event type arriving mid-request is routed as an event, not the response', async () => {
    const server = await startScriptedServer((message, reply) => {
        if (message.type === 'evaluateJSAsync') {
            // Firefox can send the unsolicited evaluationResult event from the same
            // actor before the ack — the client must not confuse the two.
            reply({ from: message.to, type: 'evaluationResult', resultID: 'r-1', result: 42 });
            reply({ from: message.to, resultID: 'r-1' });
        }
    });
    const client = await connectClient(server);
    const events = [];
    client.on('unsolicited-event', (msg) => events.push(msg));

    const ack = await client.request({ to: 'console1', type: 'evaluateJSAsync', text: '1' });
    assert.equal(ack.resultID, 'r-1');
    assert.equal(ack.type, undefined);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'evaluationResult');
    assert.equal(events[0].result, 42);

    client.disconnect();
    await server.close();
});

test('target-available-form events do not steal watchTargets responses', async () => {
    const server = await startScriptedServer((message, reply) => {
        if (message.type === 'watchTargets') {
            reply({
                from: message.to,
                type: 'target-available-form',
                target: { url: 'moz-extension://x/_generated_background_page.html', consoleActor: 'console9' },
            });
            reply({ from: message.to });
        }
    });
    const client = await connectClient(server);
    const targets = [];
    client.on('unsolicited-event', (msg) => {
        if (msg.type === 'target-available-form') targets.push(msg.target);
    });

    const response = await client.request({ to: 'watcher1', type: 'watchTargets', targetType: 'worker' });
    assert.equal(response.target, undefined);
    assert.equal(targets.length, 1);
    assert.equal(targets[0].consoleActor, 'console9');

    client.disconnect();
    await server.close();
});

test('an error reply rejects the request with an Error carrying the raw packet', async () => {
    const server = await startScriptedServer((message, reply) => {
        if (message.type === 'installTemporaryAddon') {
            reply({ from: message.to, error: 'addonInstallError', message: 'boom' });
        }
    });
    const client = await connectClient(server);

    const err = await client.request({ to: 'addons1', type: 'installTemporaryAddon' }).catch((e) => e);
    assert.ok(err instanceof Error, 'rejection should be an Error, not the raw packet');
    assert.match(err.message, /addonInstallError/);
    assert.match(err.message, /boom/);
    assert.equal(err.rdpPacket.error, 'addonInstallError');
    // The connection survives an error reply; a later request still works.
    assert.doesNotMatch(String(err.message), /\[object Object\]/);

    client.disconnect();
    await server.close();
});

test('an error reply with no message field still names the error code', async () => {
    const server = await startScriptedServer((message, reply) => {
        if (message.type === 'doThing') {
            reply({ from: message.to, error: 'someCode' });
        }
    });
    const client = await connectClient(server);
    const err = await client.request({ to: 'actor1', type: 'doThing' }).catch((e) => e);
    assert.ok(err instanceof Error);
    assert.match(err.message, /someCode/);
    client.disconnect();
    await server.close();
});

test('a from-less error packet is warned (not crashed) and the client stays usable', async () => {
    const server = await startScriptedServer((message, reply) => {
        if (message.type === 'echo') {
            reply({ from: message.to, echoed: message.payload });
        }
    });
    const client = await connectClient(server);

    // No 'error' listener yet: a from-less packet must not crash the process.
    server.send({ error: 'fromless' });
    await new Promise((resolve) => setTimeout(resolve, 30));

    // With a listener attached it is delivered as an Error naming the missing sender.
    const errors = [];
    client.on('error', (e) => errors.push(e));
    server.send({ error: 'fromless2' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(errors.length, 1);
    assert.match(String(errors[0].message), /without sender/);

    const response = await client.request({ to: 'actor1', type: 'echo', payload: 'ok' });
    assert.equal(response.echoed, 'ok');

    client.disconnect();
    await server.close();
});

test('a large frame delivered in many small slices is reassembled intact', async () => {
    const server = await startScriptedServer();
    const client = await connectClient(server);
    const events = [];
    client.on('unsolicited-event', (msg) => events.push(msg));

    const big = 'y'.repeat(200000);
    const payload = JSON.stringify({ from: 'x', type: 'blob', data: big });
    const raw = Buffer.from(`${Buffer.byteLength(payload)}:${payload}`);
    // Write in 1KB slices to exercise the incremental (chunk-list) framing path.
    for (let i = 0; i < raw.length; i += 1024) {
        server.sendRaw(raw.subarray(i, i + 1024));
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(events.length, 1);
    assert.equal(events[0].data.length, 200000);
    assert.equal(events[0].data, big);

    client.disconnect();
    await server.close();
});

test('a length header split across chunks still parses', async () => {
    const server = await startScriptedServer();
    const client = await connectClient(server);
    const events = [];
    client.on('unsolicited-event', (msg) => events.push(msg));

    const payload = JSON.stringify({ from: 'x', type: 'blob', n: 42 });
    const header = String(Buffer.byteLength(payload));
    assert.ok(header.length >= 2, 'test needs a multi-digit header to split');
    server.sendRaw(header.slice(0, 1));
    server.sendRaw(header.slice(1));
    server.sendRaw(':');
    server.sendRaw(payload);

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(events.length, 1);
    assert.equal(events[0].n, 42);

    client.disconnect();
    await server.close();
});

test('two complete frames in a single chunk are both parsed', async () => {
    const server = await startScriptedServer();
    const client = await connectClient(server);
    const events = [];
    client.on('unsolicited-event', (msg) => events.push(msg));

    server.sendRaw(frame({ from: 'x', type: 'blob', n: 1 }) + frame({ from: 'y', type: 'blob', n: 2 }));

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(events.length, 2);
    assert.equal(events[0].n, 1);
    assert.equal(events[1].n, 2);

    client.disconnect();
    await server.close();
});

test('a JSON parse error drops that message without crashing, and later messages still work', async () => {
    const server = await startScriptedServer((message, reply) => {
        if (message.type === 'echo') {
            reply({ from: message.to, echoed: message.payload });
        }
    });
    const client = await connectClient(server);
    // Deliberately NO 'error' listener: an unguarded EventEmitter 'error' emission
    // would crash the process here.

    const badJson = '{"from": "actor1", oops}';
    server.sendRaw(`${Buffer.byteLength(badJson)}:${badJson}`);
    // Give the bad packet time to arrive and be dropped.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const response = await client.request({ to: 'actor2', type: 'echo', payload: 'still-alive' });
    assert.equal(response.echoed, 'still-alive');

    client.disconnect();
    await server.close();
});

test('socket end rejects in-flight and queued requests and emits disconnect', async () => {
    const server = await startScriptedServer((message) => {
        if (message.type === 'hang') {
            server.endSocket();
        }
    });
    const client = await connectClient(server);
    let disconnected = null;
    client.on('disconnect', (err) => {
        disconnected = err;
    });

    const inFlight = client.request({ to: 'actor1', type: 'hang' });
    const queued = client.request({ to: 'actor1', type: 'also-hangs' });

    await assert.rejects(inFlight, /RDP connection closed/);
    await assert.rejects(queued, /RDP connection closed/);
    assert.match(String(disconnected?.message), /socket end/);

    await server.close();
});

test('connecting to a closed port rejects cleanly instead of crashing', async () => {
    // Find a port that is free, then close the server so nothing is listening.
    const server = await startScriptedServer();
    const { port } = server;
    await server.close();

    const client = new FirefoxRDPClient();
    await assert.rejects(client.connect(port), /ECONNREFUSED/);
});

test('requests after disconnect reject instead of throwing synchronously', async () => {
    const server = await startScriptedServer();
    const client = await connectClient(server);
    client.disconnect();
    await assert.rejects(client.request({ to: 'actor1', type: 'anything' }), /RDP connection closed/);
    await server.close();
});

test('a fatal framing error tears the connection down and rejects in-flight requests', async () => {
    const server = await startScriptedServer((message) => {
        if (message.type === 'garbage') {
            // Unparseable length prefix — fatal.
            server.sendRaw('not-a-length:{}');
        }
    });
    const client = await connectClient(server);
    const pending = client.request({ to: 'actor1', type: 'garbage' });
    await assert.rejects(pending, /RDP connection closed/);
    await server.close();
});

test('parseRDPMessage stays exported for the scripted server (framing round-trip)', () => {
    const { rdpMessage, data } = parseRDPMessage(Buffer.from(frame({ from: 'x', hi: true })));
    assert.equal(rdpMessage.hi, true);
    assert.equal(data.length, 0);
});
