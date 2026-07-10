// Covers the page fixture's postInstallPages wait: when the extension under test
// opens a tab on install, the fixture must wait for it before opening the test's own
// window (otherwise the new tab can race Juggler's new-window handling). Also covers
// the RegExp-pattern arm and the give-up branch when no matching tab ever appears.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../helpers/harnessTest.mjs';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const postinstallPath = path.join(fixturesDir, 'extension-postinstall');
const mv2Path = path.join(fixturesDir, 'extension-mv2');

test.describe('postInstallPages (substring pattern)', () => {
    test.use({ firefoxHarnessConfig: { extensionPath: postinstallPath, postInstallPages: ['post-install.html'] } });

    test('the page fixture waits for the post-install tab before opening its own', async ({ context, page }) => {
        // By the time the page fixture resolved, the post-install tab must exist.
        const urls = context.pages().map((p) => p.url());
        expect(urls.some((url) => url.includes('post-install.html'))).toBe(true);
        // And the test's own page is separate from the post-install tab.
        expect(page.url().includes('post-install.html')).toBe(false);
    });
});

test.describe('postInstallPages (RegExp pattern)', () => {
    test.use({ firefoxHarnessConfig: { extensionPath: postinstallPath, postInstallPages: [/post-install\.html$/] } });

    test('a RegExp pattern matches the post-install tab', async ({ context, page }) => {
        const urls = context.pages().map((p) => p.url());
        expect(urls.some((url) => /post-install\.html$/.test(url))).toBe(true);
        expect(page.url().includes('post-install.html')).toBe(false);
    });
});

test.describe('postInstallPages (give-up branch)', () => {
    // The plain mv2 extension opens no tab, so the pattern can never match; the page
    // fixture must proceed after the 5s deadline rather than hang (a hang would time the
    // test out). It also logs a warning, exercised here though not asserted.
    test.use({ firefoxHarnessConfig: { extensionPath: mv2Path, postInstallPages: ['never-opens.html'] } });

    test('the page fixture proceeds after the deadline when no matching tab appears', async ({ context, page }) => {
        expect(context.pages().some((p) => p.url().includes('never-opens'))).toBe(false);
        // The test's own fresh page still opened.
        expect(page.url()).toBe('about:blank');
    });
});
