// Unit tests for wrapWithNetworkBridge. A fake EventEmitter target (with a private
// field, to pin the this-binding rule) plus a stub bridge exercise the Proxy traps
// without a browser.

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { wrapWithNetworkBridge } from '../../src/proxies.js';

class FakeTarget extends EventEmitter {
    #secret = 42;
    constructor(log = []) {
        super();
        this.log = log;
        this.plainValue = 'v';
    }
    // Reads a private field, so it throws a TypeError if invoked with the Proxy as the
    // receiver rather than the real target — the rule the wrapper's bind() upholds.
    getSecret() {
        return this.#secret;
    }
    async route(...args) {
        this.log.push(['target.route', ...args]);
    }
    async unroute(...args) {
        this.log.push(['target.unroute', ...args]);
    }
    async unrouteAll(...args) {
        this.log.push(['target.unrouteAll', ...args]);
    }
}

function stubBridge() {
    const calls = [];
    return {
        calls,
        on: (...a) => calls.push(['on', ...a]),
        off: (...a) => calls.push(['off', ...a]),
        once: (...a) => calls.push(['once', ...a]),
    };
}

test('on/addListener for a bridge event route to the bridge, not the target', () => {
    const target = new FakeTarget();
    const bridge = stubBridge();
    const proxy = wrapWithNetworkBridge(target, bridge);
    const fn = () => {};

    proxy.on('requestfinished', fn);
    proxy.addListener('requestfailed', fn);

    assert.deepEqual(
        bridge.calls.map((c) => [c[0], c[1]]),
        [
            ['on', 'requestfinished'],
            ['on', 'requestfailed'],
        ],
    );
    assert.equal(target.listenerCount('requestfinished'), 0);
    assert.equal(target.listenerCount('requestfailed'), 0);
});

test('off/removeListener/once for a bridge event route to the bridge', () => {
    const bridge = stubBridge();
    const proxy = wrapWithNetworkBridge(new FakeTarget(), bridge);
    const fn = () => {};

    proxy.off('requestfinished', fn);
    proxy.removeListener('requestfailed', fn);
    proxy.once('requestfinished', fn);

    assert.deepEqual(bridge.calls.map((c) => c[0]), ['off', 'off', 'once']);
});

test('a non-bridge event lands on the target with working this-binding', () => {
    const target = new FakeTarget();
    const bridge = stubBridge();
    const proxy = wrapWithNetworkBridge(target, bridge);

    let received = null;
    proxy.on('console', (msg) => {
        received = msg;
    });
    target.emit('console', 'hello');

    assert.equal(received, 'hello');
    assert.equal(bridge.calls.length, 0);
});

test('subscription verbs return the proxy for chaining', () => {
    const proxy = wrapWithNetworkBridge(new FakeTarget(), stubBridge());
    assert.equal(proxy.on('requestfinished', () => {}), proxy);
    assert.equal(proxy.on('console', () => {}), proxy);
});

test('route() registers on the target first, then via onRoute (string pattern)', async () => {
    const log = [];
    const target = new FakeTarget(log);
    const handler = () => {};
    const proxy = wrapWithNetworkBridge(target, stubBridge(), {
        onRoute: (...a) => log.push(['onRoute', ...a]),
    });

    await proxy.route('**/x', handler);

    assert.deepEqual(log, [
        ['target.route', '**/x', handler],
        ['onRoute', '**/x', handler],
    ]);
});

test('route() with a RegExp pattern still reaches onRoute at this layer', async () => {
    // The "skip non-string patterns for the web server" rule lives in the fixtures.js
    // onRoute closure, not the proxy; the proxy forwards every pattern.
    const log = [];
    const target = new FakeTarget(log);
    const re = /example\.com/;
    const handler = () => {};
    const proxy = wrapWithNetworkBridge(target, stubBridge(), {
        onRoute: (...a) => log.push(['onRoute', ...a]),
    });

    await proxy.route(re, handler);

    assert.deepEqual(log, [
        ['target.route', re, handler],
        ['onRoute', re, handler],
    ]);
});

test('route() with an options argument warns once', async (t) => {
    const warn = t.mock.method(console, 'warn');
    const target = new FakeTarget();
    const proxy = wrapWithNetworkBridge(target, stubBridge(), { onRoute: () => {} });

    await proxy.route('**/x', () => {}, { times: 1 });

    assert.equal(warn.mock.calls.length, 1);
    assert.match(String(warn.mock.calls[0].arguments[0]), /route\(\) options are not applied/);
    // The real target.route still received all three args (['target.route', pattern, handler, options]).
    assert.equal(target.log[0].length, 4);
});

test('unroute and unrouteAll forward to the target then the callbacks', async () => {
    const log = [];
    const target = new FakeTarget(log);
    const proxy = wrapWithNetworkBridge(target, stubBridge(), {
        onRoute: () => {},
        onUnroute: (...a) => log.push(['onUnroute', ...a]),
        onUnrouteAll: (...a) => log.push(['onUnrouteAll', ...a]),
    });
    const handler = () => {};

    await proxy.unroute('**/x', handler);
    await proxy.unrouteAll();

    assert.deepEqual(log, [
        ['target.unroute', '**/x', handler],
        ['onUnroute', '**/x', handler],
        ['target.unrouteAll'],
        ['onUnrouteAll'],
    ]);
});

test('without route options, route() falls through to the plain target method', async () => {
    const log = [];
    const target = new FakeTarget(log);
    const proxy = wrapWithNetworkBridge(target, stubBridge()); // no onRoute
    const handler = () => {};

    await proxy.route('**/x', handler);

    assert.deepEqual(log, [['target.route', '**/x', handler]]);
});

test('non-function properties pass through', () => {
    const target = new FakeTarget();
    target._firefoxBridge = { marker: true };
    const proxy = wrapWithNetworkBridge(target, stubBridge());
    assert.equal(proxy.plainValue, 'v');
    assert.equal(proxy._firefoxBridge.marker, true);
});

test('methods are bound to the real target (private-field access works)', () => {
    const proxy = wrapWithNetworkBridge(new FakeTarget(), stubBridge());
    assert.equal(proxy.getSecret(), 42);
});
