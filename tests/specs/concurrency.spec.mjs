// Concurrent background evaluate() calls: each caller must receive its own result,
// regardless of settle order. evaluate() serialises calls internally (_evalLock), so
// interleaved sync, fast-promise and slow-promise evaluates must never cross wires.

import { test, expect } from '../helpers/harnessTest.mjs';

test.describe('Concurrent background eval', () => {
    test('interleaved evaluates each receive their own result', async ({ backgroundPage }) => {
        const results = await Promise.all([
            backgroundPage.evaluate(() => 'sync-a'),
            backgroundPage.evaluate((ms) => new Promise((resolve) => setTimeout(() => resolve('delay-' + ms), ms)), 120),
            backgroundPage.evaluate(() => Promise.resolve('quick-b')),
            backgroundPage.evaluate((ms) => new Promise((resolve) => setTimeout(() => resolve('delay-' + ms), ms)), 40),
            backgroundPage.evaluate(() => 21 * 2),
            backgroundPage.evaluate((tag) => Promise.resolve('tag-' + tag), 'z'),
        ]);
        expect(results).toEqual(['sync-a', 'delay-120', 'quick-b', 'delay-40', 42, 'tag-z']);
    });

    test('concurrent evaluates run their side effects serially, in submission order', async ({ backgroundPage }) => {
        // The other tests only pin result identity, which resultID matching guarantees
        // even without the lock. This pins the property the _evalLock actually exists
        // for — side-effect ordering: with strictly descending internal delays, the
        // effects would land in reverse order if the lock were removed.
        await backgroundPage.evaluate(() => {
            globalThis.__order = [];
        });
        await Promise.all([
            backgroundPage.evaluate((ms) => new Promise((r) => setTimeout(() => (globalThis.__order.push('first-120'), r()), ms)), 120),
            backgroundPage.evaluate((ms) => new Promise((r) => setTimeout(() => (globalThis.__order.push('second-60'), r()), ms)), 60),
            backgroundPage.evaluate((ms) => new Promise((r) => setTimeout(() => (globalThis.__order.push('third-10'), r()), ms)), 10),
        ]);
        expect(await backgroundPage.evaluate(() => globalThis.__order)).toEqual(['first-120', 'second-60', 'third-10']);
    });

    test('a rejection in one evaluate does not poison concurrent evaluates', async ({ backgroundPage }) => {
        const [ok1, failed, ok2] = await Promise.allSettled([
            backgroundPage.evaluate(() => Promise.resolve('before')),
            backgroundPage.evaluate(() => Promise.reject(new Error('concurrent boom'))),
            backgroundPage.evaluate(() => Promise.resolve('after')),
        ]);
        expect(ok1).toEqual({ status: 'fulfilled', value: 'before' });
        expect(failed.status).toBe('rejected');
        expect(String(failed.reason)).toContain('concurrent boom');
        expect(ok2).toEqual({ status: 'fulfilled', value: 'after' });
    });
});
