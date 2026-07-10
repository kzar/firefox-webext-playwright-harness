// Exercises the NetworkEventBridge: requests observed by the XPCOM helper are
// surfaced as Playwright-style requestfinished / requestfailed events on the
// wrapped page and context. The test extension cancels any URL containing
// "/blocked" so we can observe a blocked request.

import { test, expect } from '../helpers/harnessTest.mjs';
import { logPageRequests } from '../helpers/requests.mjs';
import { SERVER_URL } from '../helpers/constants.mjs';

test.describe('Network event logging', () => {
    test.beforeEach(async ({ backgroundPage }) => {
        // The blocking webRequest listener is registered at the end of the
        // extension's background script; wait for that before relying on it.
        await backgroundPage.waitForFunction(() => globalThis.__ready === true);
    });

    test('surfaces allowed and blocked page requests', async ({ page }) => {
        const requests = [];
        const stop = logPageRequests(page, requests, (r) => r.url.endsWith('/ok') || r.url.endsWith('/blocked'));

        await page.goto(`${SERVER_URL}/`);
        await page.evaluate(
            (base) => Promise.allSettled([fetch(`${base}/ok`), fetch(`${base}/blocked`)]),
            SERVER_URL,
        );

        await expect.poll(() => requests.length, { timeout: 10000 }).toBe(2);
        stop();

        const byUrl = Object.fromEntries(requests.map((r) => [r.url, r.status]));
        expect(byUrl[`${SERVER_URL}/ok`]).toBe('allowed');
        expect(byUrl[`${SERVER_URL}/blocked`]).toBe('blocked');
    });

    test('surfaces background-initiated requests', async ({ context, backgroundPage, backgroundNetworkContext }) => {
        // backgroundNetworkContext is the same wrapped context, sharing one event stream.
        expect(backgroundNetworkContext).toBe(context);

        const requests = [];
        const stop = logPageRequests(backgroundNetworkContext, requests, (r) => r.url.endsWith('/ok'));

        await backgroundPage.evaluate((base) => fetch(`${base}/ok`).then((r) => r.text()), SERVER_URL);

        await expect.poll(() => requests.length, { timeout: 10000 }).toBeGreaterThanOrEqual(1);
        stop();

        expect(requests.some((r) => r.status === 'allowed')).toBe(true);
    });

    test('classifies a redirected request as redirected', async ({ page }) => {
        const requests = [];
        const stop = logPageRequests(page, requests, (r) => r.url.endsWith('/redirect'));
        // Capture the redirect target directly; redirectedTo() now returns a usable
        // request-like (it used to be a bare {} that threw on .url()).
        let redirectTargetUrl = null;
        const onFinished = (request) => {
            if (request.url().endsWith('/redirect') && request.redirectedTo()) {
                redirectTargetUrl = request.redirectedTo().url();
            }
        };
        page.on('requestfinished', onFinished);

        await page.goto(`${SERVER_URL}/`);
        await page.evaluate((base) => fetch(`${base}/redirect`), SERVER_URL);

        await expect.poll(() => requests.length, { timeout: 10000 }).toBe(1);
        stop();
        page.off('requestfinished', onFinished);

        expect(requests[0].status).toBe('redirected');
        expect(redirectTargetUrl).toBe(`${SERVER_URL}/ok`);
    });

    test('maps resource types to Playwright names', async ({ page }) => {
        const requests = [];
        const stop = logPageRequests(page, requests, (r) => r.url.endsWith('/') || r.url.endsWith('/ok'));

        await page.goto(`${SERVER_URL}/`);
        await page.evaluate((base) => fetch(`${base}/ok`), SERVER_URL);

        await expect.poll(() => requests.length, { timeout: 10000 }).toBe(2);
        stop();

        const typesByUrl = Object.fromEntries(requests.map((r) => [r.url, r.type]));
        expect(typesByUrl[`${SERVER_URL}/`]).toBe('document');
        expect(typesByUrl[`${SERVER_URL}/ok`]).toBe('fetch');
    });

    test('classifies a connection failure as failed (not blocked)', async ({ page }) => {
        const requests = [];
        const stop = logPageRequests(page, requests, (r) => r.url.includes('song-of-nothing'));

        await page.goto(`${SERVER_URL}/`);
        // The .invalid TLD is guaranteed not to resolve (RFC 2606), so the request
        // fails at the network layer — which must surface as 'failed' with a
        // Firefox status, not as 'blocked'. (A closed local port won't do here:
        // Firefox refuses low ports before any observable channel activity.)
        await page.evaluate(() => fetch('http://song-of-nothing.invalid/').catch(() => 'failed'));

        await expect.poll(() => requests.length, { timeout: 10000 }).toBe(1);
        stop();

        expect(requests[0].status).toBe('failed');
        expect(requests[0].reason).toMatch(/^firefox:status=0x/);
    });

    // The following exercise the proxied (background-request) path end to end, which is
    // the integration proof of the channel-id correlation mechanism: the terminal event
    // now comes from the harness server's proxy-complete, so a fulfilled request reads as
    // 'allowed' (not 'redirected'), failures are reachable, and the finish fires only
    // after the handler ran.

    test('a route-fulfilled background request classifies as allowed, not redirected', async ({
        context,
        backgroundPage,
        backgroundNetworkContext,
    }) => {
        await context.route('**/classify.json', (route) =>
            route.fulfill({ status: 200, headers: { 'content-type': 'application/json' }, body: '{}' }),
        );
        const requests = [];
        const stop = logPageRequests(backgroundNetworkContext, requests, (r) => r.url.endsWith('/classify.json'));

        await backgroundPage.evaluate(() => fetch('https://example.com/classify.json').then((r) => r.json()));

        await expect.poll(() => requests.length, { timeout: 10000 }).toBeGreaterThanOrEqual(1);
        stop();

        expect(requests[0].status).toBe('allowed');
    });

    test('a proxied request that aborts or whose handler throws surfaces as requestfailed', async ({
        context,
        backgroundPage,
        backgroundNetworkContext,
    }) => {
        await context.route('**/abort-me', (route) => route.abort());
        await context.route('**/throw-me', () => {
            throw new Error('handler boom');
        });
        const requests = [];
        const stop = logPageRequests(backgroundNetworkContext, requests, (r) => r.url.endsWith('/abort-me') || r.url.endsWith('/throw-me'));

        await backgroundPage.evaluate(async () => {
            await fetch('https://example.com/abort-me').catch(() => {});
            await fetch('https://example.com/throw-me').catch(() => {});
        });

        await expect.poll(() => requests.length, { timeout: 10000 }).toBe(2);
        stop();

        const byUrl = Object.fromEntries(requests.map((r) => [r.url, r.status]));
        expect(byUrl['https://example.com/abort-me']).toBe('failed');
        expect(byUrl['https://example.com/throw-me']).toBe('failed');
    });

    test('requestfinished for a proxied request fires only after the route handler has run', async ({
        context,
        backgroundPage,
        backgroundNetworkContext,
    }) => {
        let handlerRan = false;
        await context.route('**/timing.json', async (route) => {
            await new Promise((resolve) => setTimeout(resolve, 100));
            handlerRan = true;
            route.fulfill({ status: 200, body: 'ok' });
        });

        // Capture whether the handler had run at the moment requestfinished fired. The
        // old synthetic-response fired at request-start (handlerRan still false).
        let ranAtFinish = null;
        const onFinished = (request) => {
            if (request.url().endsWith('/timing.json') && ranAtFinish === null) ranAtFinish = handlerRan;
        };
        backgroundNetworkContext.on('requestfinished', onFinished);

        await backgroundPage.evaluate(() => fetch('https://example.com/timing.json').then((r) => r.text()));

        await expect.poll(() => ranAtFinish !== null, { timeout: 10000 }).toBe(true);
        backgroundNetworkContext.off('requestfinished', onFinished);

        expect(ranAtFinish).toBe(true);
    });
});
