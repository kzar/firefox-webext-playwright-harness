// Unit tests for the harness-side rdpRequest() deadline wrapper. RDP matches replies to
// requests by actor with no request IDs, so a timed-out request can't be cancelled in
// isolation; the wrapper's contract is therefore "reject with a descriptive error AND
// tear the connection down", which these tests pin against the scripted server.

import test from 'node:test';
import assert from 'node:assert/strict';

import { rdpRequest } from '../../src/harness.js';
import { startScriptedServer, connectClient } from './helpers/rdp-scripted-server.mjs';

test('rdpRequest times out an unanswered request and tears the connection down', async () => {
    // A server that acks nothing: the request never gets a reply.
    const server = await startScriptedServer(() => {});
    const client = await connectClient(server);

    await assert.rejects(
        rdpRequest(client, { to: 'actor1', type: 'hang' }, { timeoutMs: 100, what: 'hang' }),
        /RDP request timed out.*hang/s,
    );

    // The timeout closed the connection, so no actor is left wedged — a follow-up
    // request fails fast with the closed-connection error rather than hanging.
    assert.equal(client._rdpConnection, null);
    await assert.rejects(rdpRequest(client, { to: 'actor2', type: 'x' }, { timeoutMs: 1000 }), /RDP connection closed/);

    await server.close();
});

test('rdpRequest resolves an answered request and leaves the connection open', async () => {
    const server = await startScriptedServer((message, reply) => {
        if (message.type === 'echo') reply({ from: message.to, echoed: message.payload });
    });
    const client = await connectClient(server);

    const response = await rdpRequest(client, { to: 'actor1', type: 'echo', payload: 'hi' }, { timeoutMs: 1000, what: 'echo' });
    assert.equal(response.echoed, 'hi');
    assert.ok(client._rdpConnection, 'connection should still be open');

    client.disconnect();
    await server.close();
});
