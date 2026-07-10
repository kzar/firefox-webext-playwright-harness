// Unit tests for the FirefoxWebServer proxy pipeline and route shim, driven directly
// over HTTP against a real server + a stub origin — no browser. The XPCOM helper sets
// the x-harness-channel-id header on the redirected request in the real flow; here the
// test sets it explicitly so the terminal proxy-complete event can be exercised.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';

import { FirefoxWebServer } from '../../src/web-server.js';

async function startServer() {
    const server = new FirefoxWebServer();
    await server.start();
    return server;
}

// Start a stub origin server; `handler(req, res, body)` runs per request with the
// collected request body. Returns a handle including the recorded requests.
async function startOrigin(handler) {
    const requests = [];
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const body = Buffer.concat(chunks);
            requests.push({ method: req.method, url: req.url, headers: req.headers, body });
            handler(req, res, body);
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    return { port, host: `127.0.0.1:${port}`, requests, close: () => new Promise((resolve) => server.close(resolve)) };
}

// Issue a /proxy/ request whose reconstructed URL is `proxyUrl`. The channel id is
// encoded as the first path segment (as the XPCOM helper does). Uses raw http so
// multi-value headers (set-cookie) survive.
function proxyFetch(server, proxyUrl, { method = 'GET', headers = {}, body, channelId = 'c1' } = {}) {
    const u = new URL(proxyUrl);
    const proxyPath = `/proxy/${channelId}/${u.protocol.replace(':', '')}/${u.host}${u.pathname}${u.search}`;
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: server.port, path: proxyPath, method, headers }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

function rawGet(server, reqPath) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: server.port, path: reqPath, method: 'GET' }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
        });
        req.on('error', reject);
        req.end();
    });
}

function postEvents(server, rawBody) {
    return new Promise((resolve, reject) => {
        const req = http.request(
            { host: '127.0.0.1', port: server.port, path: '/events', method: 'POST', headers: { 'content-type': 'application/json' } },
            (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
            },
        );
        req.on('error', reject);
        req.end(rawBody);
    });
}

// -- Proxy-to-origin path --

test('proxies a POST body to the origin and does not forward the harness channel header', async () => {
    const origin = await startOrigin((req, res, body) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('origin-got:' + body.toString());
    });
    const server = await startServer();
    try {
        const res = await proxyFetch(server, `http://${origin.host}/echo`, {
            method: 'POST',
            headers: { 'content-type': 'text/plain' },
            body: 'hello-body',
        });
        assert.equal(res.status, 200);
        assert.equal(res.body.toString(), 'origin-got:hello-body');
        const got = origin.requests[0];
        assert.equal(got.body.toString(), 'hello-body');
        assert.equal(got.headers['x-harness-channel-id'], undefined);
        assert.equal(got.headers.host, origin.host);
    } finally {
        await server.stop();
        await origin.close();
    }
});

test('a dead origin yields a 502 and a proxy-complete failure event', async () => {
    const origin = await startOrigin(() => {});
    const deadHost = origin.host;
    await origin.close(); // nothing is listening now
    const server = await startServer();
    try {
        const complete = server.waitForEvent((e) => e.type === 'proxy-complete' && e.channelId === 'dead1', 2000);
        const res = await proxyFetch(server, `http://${deadHost}/x`, { channelId: 'dead1' });
        assert.equal(res.status, 502);
        assert.equal((await complete).failure, 'net::ERR_FAILED');
    } finally {
        await server.stop();
    }
});

test('relays a redirect with an absolutised Location and marks proxy-complete redirected', async () => {
    const origin = await startOrigin((req, res) => {
        if (req.url === '/start') {
            res.writeHead(302, { location: '/final' }); // relative Location
            res.end();
        } else {
            res.writeHead(200);
            res.end('final-body');
        }
    });
    const server = await startServer();
    try {
        const complete = server.waitForEvent((e) => e.type === 'proxy-complete' && e.channelId === 'r1', 2000);
        const res = await proxyFetch(server, `http://${origin.host}/start`, { channelId: 'r1' });
        assert.equal(res.status, 302);
        assert.equal(res.headers.location, `http://${origin.host}/final`);
        assert.equal((await complete).redirectUrl, `http://${origin.host}/final`);
    } finally {
        await server.stop();
        await origin.close();
    }
});

test('relays multiple Set-Cookie headers as separate cookies', async () => {
    const origin = await startOrigin((req, res) => {
        res.setHeader('set-cookie', ['a=1', 'b=2']);
        res.writeHead(200);
        res.end('ok');
    });
    const server = await startServer();
    try {
        const res = await proxyFetch(server, `http://${origin.host}/cookies`);
        assert.deepEqual(res.headers['set-cookie'], ['a=1', 'b=2']);
    } finally {
        await server.stop();
        await origin.close();
    }
});

test('streams the origin response rather than buffering the whole body', { timeout: 10000 }, async () => {
    let sendSecond;
    const origin = await startOrigin((req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.write('chunk-1');
        // Hold the rest until the client confirms it received chunk-1 — if the harness
        // buffered the whole body it would deadlock (the test would time out).
        sendSecond = () => {
            res.write('chunk-2');
            res.end();
        };
    });
    const server = await startServer();
    try {
        const u = new URL(`http://${origin.host}/stream`);
        const got = await new Promise((resolve, reject) => {
            const req = http.request(
                { host: '127.0.0.1', port: server.port, path: `/proxy/s1/http/${u.host}/stream` },
                (res) => {
                    let first = null;
                    const chunks = [];
                    res.on('data', (c) => {
                        chunks.push(c);
                        if (first === null) {
                            first = c.toString();
                            sendSecond();
                        }
                    });
                    res.on('end', () => resolve({ first, full: Buffer.concat(chunks).toString() }));
                },
            );
            req.on('error', reject);
            req.end();
        });
        assert.equal(got.first, 'chunk-1');
        assert.equal(got.full, 'chunk-1chunk-2');
    } finally {
        await server.stop();
        await origin.close();
    }
});

// -- Input handling / events --

test('a /proxy/ path without a valid scheme is answered 400', async () => {
    const server = await startServer();
    try {
        // channelId present, but 'ftp' is not an http(s) scheme.
        assert.equal((await rawGet(server, '/proxy/c1/ftp/example.com/x')).status, 400);
    } finally {
        await server.stop();
    }
});

test('an unknown path is answered 404', async () => {
    const server = await startServer();
    try {
        assert.equal((await rawGet(server, '/nope')).status, 404);
    } finally {
        await server.stop();
    }
});

test('a malformed /events body is answered 400', async () => {
    const server = await startServer();
    try {
        assert.equal((await postEvents(server, 'not json')).status, 400);
    } finally {
        await server.stop();
    }
});

test('a non-array /events JSON body is accepted but emits nothing', async () => {
    const server = await startServer();
    const events = [];
    server.on('event', (e) => events.push(e));
    try {
        assert.equal((await postEvents(server, JSON.stringify({ not: 'an array' }))).status, 200);
        assert.equal(events.length, 0);
    } finally {
        await server.stop();
    }
});

test("an event named 'error' does not crash the server", async () => {
    const server = await startServer();
    const events = [];
    server.on('event', (e) => events.push(e));
    try {
        assert.equal((await postEvents(server, JSON.stringify([{ type: 'error', source: 'helper' }]))).status, 200);
        assert.equal(events.length, 1);
        assert.equal(events[0].type, 'error');
    } finally {
        await server.stop();
    }
});

test('a throwing event listener does not drop the rest of a batch', async () => {
    const server = await startServer();
    const seen = [];
    server.on('event', (e) => {
        seen.push(e.n);
        if (e.n === 2) throw new Error('listener boom');
    });
    try {
        assert.equal((await postEvents(server, JSON.stringify([{ n: 1 }, { n: 2 }, { n: 3 }]))).status, 200);
        assert.deepEqual(seen, [1, 2, 3]);
    } finally {
        await server.stop();
    }
});

// -- Route shim --

test('route.request() exposes method, headers, and post data', async () => {
    const server = await startServer();
    let captured;
    server.registerRoute('**/shim', (route, request) => {
        captured = {
            url: request.url(),
            method: request.method(),
            resourceType: request.resourceType(),
            ctype: request.headers()['content-type'],
            postData: request.postData(),
            postJSON: route.request().postDataJSON(),
        };
        route.fulfill({ status: 200, body: 'ok' });
    });
    try {
        await proxyFetch(server, 'http://example.com/shim', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ a: 1 }),
        });
        assert.equal(captured.url, 'http://example.com/shim');
        assert.equal(captured.method, 'POST');
        assert.equal(captured.resourceType, 'fetch');
        assert.equal(captured.ctype, 'application/json');
        assert.equal(captured.postData, '{"a":1}');
        assert.deepEqual(captured.postJSON, { a: 1 });
    } finally {
        await server.stop();
    }
});

test('fulfill supports contentType, json, path, and their precedence', async () => {
    const server = await startServer();
    const tmpFile = path.join(os.tmpdir(), `fx-fulfill-${process.pid}.json`);
    await fs.writeFile(tmpFile, JSON.stringify({ from: 'file' }));

    // contentType option beats an explicit headers['content-type'].
    server.registerRoute('**/ct', (route) =>
        route.fulfill({ contentType: 'text/plain', headers: { 'content-type': 'application/json' }, body: 'hi' }),
    );
    server.registerRoute('**/json', (route) => route.fulfill({ json: { j: 1 } }));
    server.registerRoute('**/file', (route) => route.fulfill({ path: tmpFile }));
    server.registerRoute('**/conflict', (route) => route.fulfill({ body: 'b', json: { j: 1 } }));
    try {
        const ct = await proxyFetch(server, 'http://example.com/ct');
        assert.equal(ct.headers['content-type'], 'text/plain');
        assert.equal(ct.body.toString(), 'hi');

        const j = await proxyFetch(server, 'http://example.com/json');
        assert.equal(j.headers['content-type'], 'application/json');
        assert.deepEqual(JSON.parse(j.body.toString()), { j: 1 });

        const f = await proxyFetch(server, 'http://example.com/file');
        assert.equal(f.headers['content-type'], 'application/json'); // guessed from .json
        assert.deepEqual(JSON.parse(f.body.toString()), { from: 'file' });

        // body + json is a conflict → handler throws → 500.
        assert.equal((await proxyFetch(server, 'http://example.com/conflict')).status, 500);
    } finally {
        await server.stop();
        await fs.rm(tmpFile, { force: true });
    }
});

test('abort() fails the request with no response and reports the failure', async () => {
    const server = await startServer();
    server.registerRoute('**/abort-default', (route) => route.abort());
    server.registerRoute('**/abort-code', (route) => route.abort('aborted'));
    try {
        const cd = server.waitForEvent((e) => e.type === 'proxy-complete' && e.channelId === 'ad', 2000);
        await assert.rejects(proxyFetch(server, 'http://example.com/abort-default', { channelId: 'ad' }));
        assert.equal((await cd).failure, 'net::ERR_FAILED');

        const cc = server.waitForEvent((e) => e.type === 'proxy-complete' && e.channelId === 'ac', 2000);
        await assert.rejects(proxyFetch(server, 'http://example.com/abort-code', { channelId: 'ac' }));
        assert.equal((await cc).failure, 'net::ERR_ABORTED');
    } finally {
        await server.stop();
    }
});

test('continue() hits the origin (skipping other handlers) and applies overrides; fallback() defers', async () => {
    const origin = await startOrigin((req, res, body) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(`origin:${req.method}:${req.headers['x-extra'] || ''}:${body.toString()}`);
    });
    const server = await startServer();
    try {
        // LIFO: continue() is registered last, so it runs first and must skip the fulfill.
        server.registerRoute('**/cont', (route) => route.fulfill({ status: 200, body: 'should-not-win' }));
        server.registerRoute('**/cont', (route) => route.continue({ method: 'PUT', headers: { 'x-extra': 'yes' } }));
        const cont = await proxyFetch(server, `http://${origin.host}/cont`);
        assert.match(cont.body.toString(), /^origin:PUT:yes:/);

        server.registerRoute('**/fb', (route) => route.fulfill({ status: 200, body: 'lower' }));
        server.registerRoute('**/fb', (route) => route.fallback());
        const fb = await proxyFetch(server, `http://${origin.host}/fb`);
        assert.equal(fb.body.toString(), 'lower');
    } finally {
        await server.stop();
        await origin.close();
    }
});

test('a throwing route handler yields a 500 and logs the error', async (t) => {
    const server = await startServer();
    const warn = t.mock.method(console, 'warn');
    server.registerRoute('**/boom', () => {
        throw new Error('handler boom');
    });
    try {
        assert.equal((await proxyFetch(server, 'http://example.com/boom')).status, 500);
        assert.ok(warn.mock.calls.some((c) => String(c.arguments[0]).includes('route handler error')));
    } finally {
        await server.stop();
    }
});

test('a route setting an invalid header responds (500) instead of hanging', { timeout: 10000 }, async (t) => {
    const server = await startServer();
    const warn = t.mock.method(console, 'warn');
    // A newline in a header value makes res.writeHead throw AFTER the handler returned.
    server.registerRoute('**/bad-header', (route) => route.fulfill({ headers: { 'x-bad': 'a\nb' }, body: 'x' }));
    try {
        assert.equal((await proxyFetch(server, 'http://example.com/bad-header')).status, 500);
        assert.ok(warn.mock.calls.length > 0);
    } finally {
        await server.stop();
    }
});

test('calling a second terminal method throws "Route is already handled!"', async () => {
    const server = await startServer();
    let caught = null;
    server.registerRoute('**/double', (route) => {
        route.fulfill({ status: 200, body: 'first' });
        try {
            route.abort();
        } catch (e) {
            caught = e;
        }
    });
    try {
        await proxyFetch(server, 'http://example.com/double');
        assert.ok(caught instanceof Error);
        assert.match(caught.message, /already handled/);
    } finally {
        await server.stop();
    }
});

test('proxy-complete reflects the written response (fires after it is complete)', async () => {
    const server = await startServer();
    server.registerRoute('**/timed', (route) => route.fulfill({ status: 200, body: 'done' }));
    try {
        const complete = server.waitForEvent((e) => e.type === 'proxy-complete' && e.channelId === 't1', 2000);
        await proxyFetch(server, 'http://example.com/timed', { channelId: 't1' });
        const event = await complete;
        assert.equal(event.statusCode, 200);
        assert.equal(event.failure, null);
    } finally {
        await server.stop();
    }
});
