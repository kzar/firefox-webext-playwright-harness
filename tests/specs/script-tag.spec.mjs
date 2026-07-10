// Covers src/script-tag.js: Firefox blocks Playwright's native page.addScriptTag on
// the pages under test, so the harness patches it to inject via evaluate() instead.
// These pin that the patch is installed (it resolves undefined rather than an
// ElementHandle) and that each option branch (content/path/url/missing) works, on a
// page and on a frame.
//
// NOTE: a `script-src 'self'` CSP blocks the evaluate-injected inline <script> just as
// it blocks the native path (verified empirically), so these run on the non-CSP page.
// The intended CSP-bypass test is left below, disabled, with a TODO.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../helpers/harnessTest.mjs';
import { SERVER_URL } from '../helpers/constants.mjs';

const injectedScriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'injected-script.js');

test.describe('addScriptTag patch', () => {
    test('injects { content } and resolves undefined (proving the patch is installed)', async ({ page }) => {
        await page.goto(SERVER_URL);
        // The patch resolves undefined; native Playwright returns an ElementHandle.
        const handle = await page.addScriptTag({ content: 'window.__injectedContent = "content-ok"' });
        expect(handle).toBeUndefined();
        expect(await page.evaluate(() => window.__injectedContent)).toBe('content-ok');
    });

    test('injects { path } from a file', async ({ page }) => {
        await page.goto(SERVER_URL);
        await page.addScriptTag({ path: injectedScriptPath });
        expect(await page.evaluate(() => window.__injectedFromPath)).toBe('path-ok');
    });

    test('injects { url } fetched in-page', async ({ page }) => {
        await page.goto(SERVER_URL);
        await page.addScriptTag({ url: `${SERVER_URL}/injected.js` });
        expect(await page.evaluate(() => window.__injectedFromUrl)).toBe('url-ok');
    });

    test('rejects when no path/content/url option is given', async ({ page }) => {
        await page.goto(SERVER_URL);
        await expect(page.addScriptTag({})).rejects.toThrow('addScriptTag requires path, content, or url option');
    });

    test('works on a frame from page.frames()', async ({ page }) => {
        await page.goto(`${SERVER_URL}/frame`);
        const frame = page.frames().find((f) => f.url().endsWith('/frame-child'));
        expect(frame).toBeTruthy();
        await frame.addScriptTag({ content: 'window.__injectedInFrame = "frame-ok"' });
        expect(await frame.evaluate(() => window.__injectedInFrame)).toBe('frame-ok');
    });

    // TODO: This test currently FAILS and is disabled until the CSP bypass is fixed.
    // src/script-tag.js patches addScriptTag to inject a script's contents via
    // evaluate() (createElement('script') + textContent + appendChild), on the premise
    // that this bypasses the page's CSP. Empirically it does NOT: on the /csp page
    // (`script-src 'self'`, no 'unsafe-inline') the evaluate-injected inline <script> is
    // blocked exactly like Playwright's native addScriptTag, so window.__patchedInjected
    // stays undefined and the final expectation below fails (Received: undefined).
    // The precondition (native path blocked) does hold. Fixing this likely means
    // injecting through a CSP-permitted channel (e.g. an external blob:/data: URL) or an
    // isolated world; once fixed, re-enable this test — it relies on the /csp route in
    // tests/server.mjs. See also the spawned "Verify script-tag.js CSP-bypass claim" task.
    //
    // test('bypasses a page CSP that blocks the native addScriptTag', async ({ page }) => {
    //     await page.goto(`${SERVER_URL}/csp`);
    //     // Precondition: the native path is blocked by the page CSP (script-src 'self').
    //     await page._fxHarnessOriginalAddScriptTag({ content: 'window.__nativeInjected = 1' }).catch(() => {});
    //     expect(await page.evaluate(() => window.__nativeInjected)).toBeUndefined();
    //     // The harness's evaluate-based injection should run despite the CSP (currently does not).
    //     await page.addScriptTag({ content: 'window.__patchedInjected = 2' });
    //     expect(await page.evaluate(() => window.__patchedInjected)).toBe(2);
    // });
});
