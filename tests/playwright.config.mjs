import { defineConfig } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERVER_PORT } from './helpers/constants.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Maps a Firefox-only config filename to the one the route handler serves, to
// exercise the harness's rewriteStaticRules feature (see routing.spec.mjs).
const rewriteStaticRules = [['test-config-firefox.json', 'test-config.json']];

export default defineConfig({
    testDir: './specs',
    // RDP/extension install per test adds overhead, so allow more than Playwright's
    // 30s default.
    timeout: 60_000,
    // Each test is fully isolated (its own Firefox, RDP port and web server), so they
    // can run in parallel. fullyParallel lets `--repeat-each` spread its repeats across
    // `--workers`, which is what makes flake-detection runs useful, e.g.:
    //   npm test --workspace tests -- --repeat-each=30 --workers=10
    fullyParallel: true,
    workers: 4,
    reporter: [['list'], ['html', { open: 'never' }]],
    // Patches Playwright's bundled Firefox once before workers start.
    globalSetup: 'firefox-webext-playwright-harness/globalSetup',
    webServer: {
        command: 'node server.mjs',
        port: SERVER_PORT,
        reuseExistingServer: !process.env.CI,
    },
    projects: [
        {
            name: 'firefox-mv2',
            use: {
                firefoxHarnessConfig: {
                    extensionPath: path.join(__dirname, 'fixtures', 'extension-mv2'),
                    rewriteStaticRules,
                },
            },
        },
        {
            name: 'firefox-mv3',
            use: {
                firefoxHarnessConfig: {
                    extensionPath: path.join(__dirname, 'fixtures', 'extension-mv3'),
                    rewriteStaticRules,
                },
            },
        },
    ],
});
