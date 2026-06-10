// Exercises the JugglerFrameChild moz-extension:// patch (ensureFirefoxPatched,
// patch #3): Playwright/Juggler must be able to instrument a page served from the
// extension's own moz-extension:// origin. Without the patch Juggler bails out
// early on moz-extension:// frames, so navigating to and driving the page here
// would hang or fail.

import { test, expect } from '../helpers/harnessTest.mjs';

test.describe('moz-extension:// page', () => {
    test("Juggler can drive the extension's own page", async ({ page, backgroundPage }) => {
        const url = await backgroundPage.evaluate(() => chrome.runtime.getURL('page.html'));
        expect(url).toMatch(/^moz-extension:\/\/.+\/page\.html$/);

        await page.goto(url);

        await expect(page).toHaveTitle('Harness extension page');
        await expect(page.locator('#marker')).toHaveText('extension page loaded');
        expect(await page.evaluate(() => document.location.protocol)).toBe('moz-extension:');
    });
});
