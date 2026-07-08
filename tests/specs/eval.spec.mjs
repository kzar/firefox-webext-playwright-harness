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

    test('resolves a promise result', async ({ backgroundPage }) => {
        const value = await backgroundPage.evaluate(() => Promise.resolve(21 * 2));
        expect(value).toBe(42);
    });

    test('resolves a promise that settles after a delay', async ({ backgroundPage }) => {
        // The value isn't ready on the first read of the result slot, so this exercises
        // the re-read loop rather than the immediate path.
        const value = await backgroundPage.evaluate(
            (ms) => new Promise((resolve) => setTimeout(() => resolve('delayed'), ms)),
            200,
        );
        expect(value).toBe('delayed');
    });

    test('propagates a synchronous error', async ({ backgroundPage }) => {
        await expect(
            backgroundPage.evaluate(() => {
                throw new Error('sync boom');
            }),
        ).rejects.toThrow('sync boom');
    });

    test('propagates a rejected promise', async ({ backgroundPage }) => {
        await expect(backgroundPage.evaluate(() => Promise.reject(new Error('async boom')))).rejects.toThrow('async boom');
    });

    test('round-trips falsy return values', async ({ backgroundPage }) => {
        expect(await backgroundPage.evaluate(() => undefined)).toBeUndefined();
        expect(await backgroundPage.evaluate(() => null)).toBeNull();
        expect(await backgroundPage.evaluate(() => false)).toBe(false);
        expect(await backgroundPage.evaluate(() => 0)).toBe(0);
        expect(await backgroundPage.evaluate(() => '')).toBe('');
    });

    test('waitForFunction resolves once its predicate is true', async ({ backgroundPage }) => {
        // Flip a global after a short delay; waitForFunction polls via evaluate() until true.
        await backgroundPage.evaluate(() => {
            globalThis.__ready = false;
            setTimeout(() => {
                globalThis.__ready = true;
            }, 150);
        });
        const result = await backgroundPage.waitForFunction(() => globalThis.__ready === true);
        expect(result).toBe(true);
    });
});
