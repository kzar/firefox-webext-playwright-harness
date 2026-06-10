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

    test('surfaces background-initiated requests', async ({ backgroundPage, backgroundNetworkContext }) => {
        const requests = [];
        const stop = logPageRequests(backgroundNetworkContext, requests, (r) => r.url.endsWith('/ok'));

        await backgroundPage.evaluate((base) => fetch(`${base}/ok`).then((r) => r.text()), SERVER_URL);

        await expect.poll(() => requests.length, { timeout: 10000 }).toBeGreaterThanOrEqual(1);
        stop();

        expect(requests.some((r) => r.status === 'allowed')).toBe(true);
    });
});
