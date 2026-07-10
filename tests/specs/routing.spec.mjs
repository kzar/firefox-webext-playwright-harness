// Exercises the harness's signature feature: a background-initiated http(s)
// request is redirected by the XPCOM helper to the harness web server, where a
// route registered through the wrapped context.route() can fulfill it (Juggler
// can't intercept the extension's background requests the way Chrome's DevTools
// protocol can).

import { test, expect } from '../helpers/harnessTest.mjs';

test.describe('Background request routing', () => {
    test('fulfills a background request via context.route()', async ({ context, backgroundPage }) => {
        await context.route('**/test-config.json', (route) =>
            route.fulfill({
                status: 200,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ hello: 'world' }),
            }),
        );

        const config = await backgroundPage.evaluate(async () => {
            const response = await fetch('https://example.com/test-config.json');
            return response.json();
        });

        expect(config).toEqual({ hello: 'world' });
    });

    test('applies rewriteStaticRules before matching the route', async ({ context, backgroundPage }) => {
        // The route is registered for the rewritten name; the extension fetches the
        // Firefox-specific name, which rewriteStaticRules (set in the config) maps
        // onto it before the web server matches routes.
        await context.route('**/test-config.json', (route) =>
            route.fulfill({
                status: 200,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ source: 'rewritten' }),
            }),
        );

        const config = await backgroundPage.evaluate(async () => {
            const response = await fetch('https://example.com/test-config-firefox.json');
            return response.json();
        });

        expect(config).toEqual({ source: 'rewritten' });
    });

    test('the most recently registered route wins (LIFO), like Playwright', async ({ context, backgroundPage }) => {
        await context.route('**/test-config.json', (route) => route.fulfill({ status: 200, body: 'first' }));
        await context.route('**/test-config.json', (route) => route.fulfill({ status: 200, body: 'second' }));

        const body = await backgroundPage.evaluate(async () => {
            const response = await fetch('https://example.com/test-config.json');
            return response.text();
        });

        expect(body).toBe('second');
    });

    test('route.fallback() falls through to the next matching route', async ({ context, backgroundPage }) => {
        await context.route('**/test-config.json', (route) => route.fulfill({ status: 200, body: 'underneath' }));
        await context.route('**/test-config.json', (route) => route.fallback());

        const body = await backgroundPage.evaluate(async () => {
            const response = await fetch('https://example.com/test-config.json');
            return response.text();
        });

        expect(body).toBe('underneath');
    });

    test('route.continue() goes to the origin, skipping remaining routes and the base handler', async ({ context, backgroundPage }) => {
        // A lower route that WOULD fulfill — continue() must skip it (and the base
        // handler) and hit the network instead, which is Playwright's contract.
        await context.route('**/skip-me', (route) => route.fulfill({ status: 200, body: 'should-not-see-this' }));
        await context.route('**/skip-me', (route) => route.continue());

        const result = await backgroundPage.evaluate(async () => {
            // song-of-nothing.invalid never resolves (RFC 2606), so reaching the network
            // yields the harness server's 502 rather than any mocked body.
            const response = await fetch('http://song-of-nothing.invalid/skip-me');
            return { status: response.status, body: await response.text() };
        });

        expect(result.body).not.toBe('should-not-see-this');
        expect(result.status).toBe(502);
    });

    test('route.fulfill() honours contentType and json', async ({ context, backgroundPage }) => {
        await context.route('**/via-content-type', (route) =>
            route.fulfill({ contentType: 'application/json', body: JSON.stringify({ via: 'contentType' }) }),
        );
        await context.route('**/via-json', (route) => route.fulfill({ json: { via: 'json' } }));

        const result = await backgroundPage.evaluate(async () => {
            const a = await fetch('https://example.com/via-content-type');
            const b = await fetch('https://example.com/via-json');
            return {
                aType: a.headers.get('content-type'),
                aBody: await a.json(),
                bType: b.headers.get('content-type'),
                bBody: await b.json(),
            };
        });

        expect(result.aType).toContain('application/json');
        expect(result.aBody).toEqual({ via: 'contentType' });
        expect(result.bType).toContain('application/json');
        expect(result.bBody).toEqual({ via: 'json' });
    });

    test("route.abort() rejects the extension's fetch", async ({ context, backgroundPage }) => {
        await context.route('**/aborted', (route) => route.abort());

        const result = await backgroundPage.evaluate(async () => {
            try {
                await fetch('https://example.com/aborted');
                return 'resolved';
            } catch {
                return 'rejected';
            }
        });

        // Playwright's abort() fails the request (unlike an empty 204 success).
        expect(result).toBe('rejected');
    });

    test('unroute() stops the web server matching the route too', async ({ context, backgroundPage }) => {
        const handler = (route) => route.fulfill({ status: 200, body: 'mocked' });
        await context.route('**/test-config.json', (route) => route.fulfill({ status: 200, body: 'base' }));
        await context.route('**/test-config.json', handler);

        const fetchIt = () =>
            backgroundPage.evaluate(async () => {
                const response = await fetch('https://example.com/test-config.json');
                return response.text();
            });

        expect(await fetchIt()).toBe('mocked');
        await context.unroute('**/test-config.json', handler);
        // With the specific handler unrouted, the earlier route matches again.
        expect(await fetchIt()).toBe('base');
    });

    test('preserves the URL scheme of proxied background requests', async ({ context, backgroundPage }) => {
        // Registered last, so LIFO checks it first — it must NOT match the http URL.
        await context.route('http://example.com/**', (route) => route.fulfill({ status: 200, body: 'insecure' }));
        await context.route('https://example.com/**', (route) => route.fulfill({ status: 200, body: 'secure' }));

        const body = await backgroundPage.evaluate(async () => {
            const response = await fetch('http://example.com/scheme-test');
            return response.text();
        });

        expect(body).toBe('insecure');
    });

    test('glob alternatives ({a,b}) match like Playwright', async ({ context, backgroundPage }) => {
        await context.route('**/{alpha,beta}.json', (route) => route.fulfill({ status: 200, body: 'group' }));

        const bodies = await backgroundPage.evaluate(async () => {
            const alpha = await (await fetch('https://example.com/alpha.json')).text();
            const beta = await (await fetch('https://example.com/beta.json')).text();
            return [alpha, beta];
        });

        expect(bodies).toEqual(['group', 'group']);
    });
});
