// Unit tests for NetworkEventBridge. The bridge only needs an object with on/off, so a
// bare EventEmitter is the stub; emission is fully synchronous, so no waiting anywhere.
// Covers both the XPCOM (source 'xpcom') and proxied (source 'server' proxy-complete)
// terminal-event paths.

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { NetworkEventBridge } from '../../src/network-bridge.js';

function makeBridge() {
    const server = new EventEmitter();
    const bridge = new NetworkEventBridge(server);
    const finished = [];
    const failed = [];
    bridge.on('requestfinished', (r) => finished.push(r));
    bridge.on('requestfailed', (r) => failed.push(r));
    return { server, bridge, finished, failed, emit: (e) => server.emit('event', e) };
}

const req = (channelId, over = {}) => ({
    source: 'xpcom',
    type: 'request',
    channelId,
    url: 'https://example.com/x',
    method: 'GET',
    contentPolicyType: 20,
    ...over,
});
const resp = (channelId, over = {}) => ({ source: 'xpcom', type: 'response', channelId, url: 'https://example.com/x', ...over });
const cached = (channelId, over = {}) => ({ source: 'xpcom', type: 'cached-response', channelId, url: 'https://example.com/x', ...over });
const stop = (channelId, requestStatus, over = {}) => ({ source: 'xpcom', type: 'stop', channelId, requestStatus, ...over });
const proxyComplete = (channelId, over = {}) => ({
    source: 'server',
    type: 'proxy-complete',
    channelId,
    url: 'https://example.com/x',
    method: 'GET',
    ...over,
});

// -- Non-proxied (XPCOM) flow --

test('request then response emits exactly one requestfinished', () => {
    const { emit, finished, failed } = makeBridge();
    emit(req('c1'));
    emit(resp('c1'));
    assert.equal(finished.length, 1);
    assert.equal(failed.length, 0);
    assert.equal(finished[0].url(), 'https://example.com/x');
    assert.equal(finished[0].method(), 'GET');
    assert.equal(finished[0].resourceType(), 'fetch');
    assert.equal(finished[0].redirectedTo(), null);
    assert.equal(finished[0].failure(), null);
});

test('request then cached-response emits one requestfinished', () => {
    const { emit, finished } = makeBridge();
    emit(req('c1'));
    emit(cached('c1'));
    assert.equal(finished.length, 1);
});

test('request, response, then stop emits exactly one requestfinished (dedup)', () => {
    const { emit, finished } = makeBridge();
    emit(req('c1'));
    emit(resp('c1'));
    emit(stop('c1', 0));
    assert.equal(finished.length, 1);
});

test('a stop with no prior request is ignored', () => {
    const { emit, finished, failed } = makeBridge();
    emit(stop('c1', 0));
    assert.equal(finished.length, 0);
    assert.equal(failed.length, 0);
});

test('request then stop(NS_OK) with no response emits requestfinished', () => {
    const { emit, finished } = makeBridge();
    emit(req('c1'));
    emit(stop('c1', 0));
    assert.equal(finished.length, 1);
});

test('request then stop(NS_ERROR_ABORT) emits requestfailed as net::ERR_ABORTED', () => {
    const { emit, failed } = makeBridge();
    emit(req('c1'));
    emit(stop('c1', 0x80004004));
    assert.equal(failed.length, 1);
    assert.equal(failed[0].failure().errorText, 'net::ERR_ABORTED');
});

test('request then stop(other error) emits requestfailed with the hex status', () => {
    const { emit, failed } = makeBridge();
    emit(req('c1'));
    emit(stop('c1', 0x804b000e));
    assert.equal(failed.length, 1);
    assert.equal(failed[0].failure().errorText, 'firefox:status=0x804b000e');
});

test('a response redirect marks redirectedTo() with an absolutised url', () => {
    const { emit, finished } = makeBridge();
    emit(req('c1'));
    emit(resp('c1', { url: 'https://example.com/redirect', redirectUrl: '/ok' }));
    assert.equal(finished.length, 1);
    assert.ok(finished[0].redirectedTo());
    assert.equal(finished[0].redirectedTo().url(), 'https://example.com/ok');
});

test('events from a non-xpcom/non-server source, or without a channelId, are ignored', () => {
    const { emit, server, finished, failed } = makeBridge();
    emit({ type: 'ready', source: 'helper' });
    emit({ source: 'helper', type: 'stop', channelId: 'c1', requestStatus: 0 });
    emit(req(undefined));
    server.emit('event', resp('c1')); // no matching request
    assert.equal(finished.length, 0);
    assert.equal(failed.length, 0);
});

test('resourceType maps content-policy types to Playwright names', () => {
    const rows = [
        [6, 'document'],
        [7, 'document'],
        [11, 'xhr'],
        [19, 'other'], // beacon
        [16, 'websocket'],
        [21, 'image'], // imageset
        [22, 'manifest'],
        [20, 'fetch'],
        [2, 'script'],
        [3, 'image'],
        [4, 'stylesheet'],
        [14, 'font'],
        [15, 'media'],
        [5, 'other'], // object
        [999, 'other'], // unknown int
        [undefined, 'other'], // missing
    ];
    rows.forEach(([cpt, expected], i) => {
        const { emit, finished } = makeBridge();
        const c = `t${i}`;
        emit(req(c, { contentPolicyType: cpt }));
        emit(resp(c));
        assert.equal(finished[0].resourceType(), expected, `contentPolicyType ${cpt} → ${expected}`);
    });
});

test('dispose() detaches from the server and stops emitting', () => {
    const { server, bridge, emit, finished } = makeBridge();
    bridge.dispose();
    assert.equal(server.listenerCount('event'), 0);
    emit(req('c1'));
    emit(resp('c1'));
    assert.equal(finished.length, 0);
});

test('once() fires exactly once', () => {
    const server = new EventEmitter();
    const bridge = new NetworkEventBridge(server);
    let count = 0;
    bridge.once('requestfinished', () => {
        count++;
    });
    server.emit('event', req('a'));
    server.emit('event', resp('a'));
    server.emit('event', req('b'));
    server.emit('event', resp('b'));
    assert.equal(count, 1);
});

// -- Proxied flow (terminal event is the server's proxy-complete) --

test('a proxied request is resolved by proxy-complete, not response events', () => {
    const { emit, finished } = makeBridge();
    emit(req('p1', { proxied: true }));
    emit(proxyComplete('p1'));
    assert.equal(finished.length, 1);
    assert.equal(finished[0].redirectedTo(), null);
});

test('a proxy-complete arriving before its request event is buffered and drained', () => {
    const { emit, finished } = makeBridge();
    emit(proxyComplete('p1')); // arrives first
    assert.equal(finished.length, 0);
    emit(req('p1', { proxied: true }));
    assert.equal(finished.length, 1);
});

test('the original channel redirect-stop is non-terminal; proxy-complete finishes once', () => {
    const { emit, finished, failed } = makeBridge();
    emit(req('p1', { proxied: true }));
    emit(stop('p1', 0x804b0003)); // NS_BINDING_REDIRECTED — must NOT be terminal
    assert.equal(finished.length, 0);
    emit(proxyComplete('p1'));
    assert.equal(finished.length, 1);
    assert.equal(failed.length, 0);
});

test('a proxy-complete failure emits requestfailed', () => {
    const { emit, failed } = makeBridge();
    emit(req('p1', { proxied: true }));
    emit(proxyComplete('p1', { failure: 'net::ERR_FAILED' }));
    assert.equal(failed.length, 1);
    assert.equal(failed[0].failure().errorText, 'net::ERR_FAILED');
});

test('a proxied stop with a real error status fails, and a late proxy-complete is swallowed', () => {
    const { emit, finished, failed } = makeBridge();
    emit(req('p1', { proxied: true }));
    emit(stop('p1', 0x804b000e)); // a real failure of the proxy hop
    assert.equal(failed.length, 1);
    emit(proxyComplete('p1')); // late — must be swallowed, not double-emit
    assert.equal(finished.length, 0);
    assert.equal(failed.length, 1);
});

test('proxy-complete carries redirectUrl so redirectedTo().url() works', () => {
    const { emit, finished } = makeBridge();
    emit(req('p1', { proxied: true }));
    emit(proxyComplete('p1', { redirectUrl: 'https://example.com/final' }));
    assert.equal(finished.length, 1);
    assert.equal(finished[0].redirectedTo().url(), 'https://example.com/final');
});
