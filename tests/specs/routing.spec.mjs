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
});
