// Exercises FirefoxBackgroundPage.evaluate over RDP — ported from the DuckDuckGo
// extension's playwright-harness.spec.js "Background script eval" block, adapted
// to this repo's minimal test extension.

import { test, expect } from '../helpers/harnessTest.mjs';

test.describe('Background script eval', () => {
    test('evaluates a simple expression', async ({ backgroundPage }) => {
        expect(await backgroundPage.evaluate(() => 2 + 3)).toBe(5);
    });

    test('passes string arguments', async ({ backgroundPage }) => {
        const greeting = await backgroundPage.evaluate((name) => 'Hello, ' + name, 'world');
        expect(greeting).toBe('Hello, world');
    });

    test('passes object arguments', async ({ backgroundPage }) => {
        const sum = await backgroundPage.evaluate(({ a, b }) => a + b, { a: 2, b: 3 });
        expect(sum).toBe(5);
    });

    test('passes large object arguments', async ({ backgroundPage }) => {
        const items = Array.from({ length: 100 }, (_, i) => ({ id: i, name: 'x'.repeat(80) }));
        const result = await backgroundPage.evaluate(
            (received) => ({
                count: received.length,
                first: received[0],
                last: received[received.length - 1],
            }),
            items,
        );
        expect(result.count).toBe(100);
        expect(result.first).toEqual({ id: 0, name: 'x'.repeat(80) });
        expect(result.last).toEqual({ id: 99, name: 'x'.repeat(80) });
    });

    test('returns objects', async ({ backgroundPage }) => {
        const obj = await backgroundPage.evaluate(() => ({ foo: 'bar', num: 42, bool: true }));
        expect(obj).toEqual({ foo: 'bar', num: 42, bool: true });
    });

    test('returns arrays', async ({ backgroundPage }) => {
        const arr = await backgroundPage.evaluate(() => [1, 2, 3, 'four']);
        expect(arr).toEqual([1, 2, 3, 'four']);
    });

    test('can read the extension manifest', async ({ backgroundPage }) => {
        const name = await backgroundPage.evaluate(() => chrome.runtime.getManifest().name);
        expect(name).toMatch(/^Harness Test Extension/);
    });
});
