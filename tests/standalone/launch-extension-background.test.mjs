// Coverage for the standalone launchExtensionBackground entry point — the API the
// DuckDuckGo extension's ddg2dnr unit tests use. Runs under node:test (not
// @playwright/test) so no globalSetup omni.ja patching is involved: in CI this runs
// against the stock bundled Firefox, exactly like downstream consumers. (Locally the
// binary may already be patched by earlier Playwright runs; the patches are additive,
// so behaviour is unchanged.)

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { launchExtensionBackground } from '../../src/index.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const extensionPath = path.join(fixturesDir, 'extension-mv2');

test('launchExtensionBackground drives a background evaluate end to end', async () => {
    const { background, close } = await launchExtensionBackground({ extensionPath });
    try {
        // Sync value
        assert.equal(await background.evaluate(() => 2 + 3), 5);

        // Arguments (JSON round-trip)
        assert.equal(
            await background.evaluate(({ a, b }) => a + b, { a: 20, b: 22 }),
            42,
        );

        // Promise results, immediate and delayed
        assert.equal(await background.evaluate(() => Promise.resolve('now')), 'now');
        assert.equal(
            await background.evaluate((ms) => new Promise((resolve) => setTimeout(() => resolve('later'), ms)), 100),
            'later',
        );

        // Falsy round-trips
        assert.equal(await background.evaluate(() => undefined), undefined);
        assert.equal(await background.evaluate(() => null), null);
        assert.equal(await background.evaluate(() => 0), 0);

        // Errors propagate
        await assert.rejects(
            background.evaluate(() => {
                throw new Error('standalone boom');
            }),
            /standalone boom/,
        );

        // Large result (longString grip reassembly)
        const big = await background.evaluate((n) => 'x'.repeat(n), 30000);
        assert.equal(big.length, 30000);

        // The extension really is installed
        const manifestName = await background.evaluate(() => chrome.runtime.getManifest().name);
        assert.match(manifestName, /^Harness Test Extension/);
    } finally {
        await close();
    }
});

test('close() is idempotent', async () => {
    const { background, close } = await launchExtensionBackground({ extensionPath });
    assert.equal(await background.evaluate(() => 1), 1);
    await close();
    await close(); // second close must be a no-op, not an error
});

test('a nonexistent extensionPath rejects with a useful error and leaves no temp dir', async () => {
    const tmp = os.tmpdir();
    const before = new Set(fs.readdirSync(tmp).filter((name) => name.startsWith('firefox-ext-background-')));

    const err = await launchExtensionBackground({ extensionPath: '/nonexistent/harness/extension' }).catch((e) => e);
    assert.ok(err instanceof Error, 'rejection should be an Error');
    assert.ok(err.message.length > 0);
    // The vendored client used to reject with a raw packet that stringified to this.
    assert.doesNotMatch(err.message, /\[object Object\]/);

    // The user-data temp dir this launch created must have been cleaned up on failure.
    const after = fs.readdirSync(tmp).filter((name) => name.startsWith('firefox-ext-background-') && !before.has(name));
    assert.deepEqual(after, [], `leaked temp dirs: ${after.join(', ')}`);
});

test('supports an extension declaring background.page (not background.scripts)', async () => {
    const { background, close } = await launchExtensionBackground({
        extensionPath: path.join(fixturesDir, 'extension-background-page'),
    });
    try {
        assert.equal(await background.evaluate(() => 2 + 3), 5);
        const manifestName = await background.evaluate(() => chrome.runtime.getManifest().name);
        assert.match(manifestName, /Background Page/);
    } finally {
        await close();
    }
});
