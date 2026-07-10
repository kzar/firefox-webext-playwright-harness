// Pins the pass-through of standard Playwright option-fixtures to the Firefox launch
// (buildFirefoxLaunchOptions): if the forwarding drifts, these settings silently
// revert to Playwright defaults with no failing test anywhere else. Also pins that the
// harness's required prefs win over a consumer trying to clobber them.

import { test, expect } from '../helpers/harnessTest.mjs';
import { SERVER_URL } from '../helpers/constants.mjs';

test.use({
    locale: 'de-DE',
    timezoneId: 'Asia/Tokyo',
    viewport: { width: 800, height: 600 },
    userAgent: 'HarnessUA/1.0',
    colorScheme: 'dark',
    launchOptions: {
        firefoxUserPrefs: {
            // A consumer pref the harness doesn't reserve — must apply. Notification is
            // WebIDL [Pref]-gated on this, so it becomes undefined in the page.
            'dom.webnotifications.enabled': false,
            // An attempt to clobber a HARNESS_REQUIRED_PREFS entry — must be overridden,
            // or the RDP debugger never starts and the context can't be driven at all.
            'devtools.debugger.remote-enabled': false,
        },
    },
});

test.describe('Playwright option pass-through', () => {
    test('standard options and the prefs merge reach the launched Firefox', async ({ page, backgroundPage }) => {
        await page.goto(SERVER_URL);
        expect(await page.evaluate(() => navigator.language)).toBe('de-DE');
        expect(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe('Asia/Tokyo');
        expect(await page.evaluate(() => [window.innerWidth, window.innerHeight])).toEqual([800, 600]);
        expect(await page.evaluate(() => navigator.userAgent)).toBe('HarnessUA/1.0');
        expect(await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(true);
        // Consumer pref applied (Notification is gated on dom.webnotifications.enabled).
        expect(await page.evaluate(() => typeof Notification)).toBe('undefined');
        // The harness still connected over RDP despite the consumer setting
        // devtools.debugger.remote-enabled=false — proving HARNESS_REQUIRED_PREFS won.
        expect(await backgroundPage.evaluate(() => 6 * 7)).toBe(42);
    });
});
