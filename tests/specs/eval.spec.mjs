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

    test('returns a result larger than the RDP inline limit', async ({ backgroundPage }) => {
        // Results over ~10KB come back as a longString grip that has to be reassembled
        // from its actor; before that was handled a large result was misread and the
        // evaluate hung until timeout.
        const size = 50000;
        const big = await backgroundPage.evaluate((n) => 'y'.repeat(n), size);
        expect(big).toHaveLength(size);
        expect(big).toBe('y'.repeat(size));
    });

    test('returns a large result from a resolved promise', async ({ backgroundPage }) => {
        // The settled value is delivered in the single awaited evaluationResult, so a
        // large value exercises the longString handling on the awaited path too.
        const size = 50000;
        const big = await backgroundPage.evaluate((n) => Promise.resolve('z'.repeat(n)), size);
        expect(big).toHaveLength(size);
        expect(big).toBe('z'.repeat(size));
    });

    test('resolves a promise result', async ({ backgroundPage }) => {
        const value = await backgroundPage.evaluate(() => Promise.resolve(21 * 2));
        expect(value).toBe(42);
    });

    test('resolves a promise that settles after a delay', async ({ backgroundPage }) => {
        // The console actor holds the evaluationResult until the promise settles
        // (mapped: { await: true }), so this exercises the server-side await.
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

    test('propagates a thrown string', async ({ backgroundPage }) => {
        await expect(
            backgroundPage.evaluate(() => {
                // eslint-disable-next-line no-throw-literal
                throw 'string boom';
            }),
        ).rejects.toThrow('string boom');
    });

    test('propagates a thrown plain object', async ({ backgroundPage }) => {
        await expect(backgroundPage.evaluate(() => Promise.reject({ code: 42 }))).rejects.toThrow('{"code":42}');
    });

    test('preserves the remote error name', async ({ backgroundPage }) => {
        const error = await backgroundPage
            .evaluate(() => {
                throw new TypeError('type boom');
            })
            .catch((e) => e);
        expect(error.name).toBe('TypeError');
        expect(error.message).toContain('type boom');
    });

    test('rejects with a clear error for an unserialisable argument', async ({ backgroundPage }) => {
        await expect(backgroundPage.evaluate((cb) => cb(), () => 1)).rejects.toThrow(
            'Unsupported evaluate() argument at index 0: function is not serializable',
        );
    });

    test('supports undefined arguments, including before later arguments', async ({ backgroundPage }) => {
        expect(await backgroundPage.evaluate((a) => typeof a, undefined)).toBe('undefined');
        expect(await backgroundPage.evaluate((a, b) => [typeof a, b], undefined, 5)).toEqual(['undefined', 5]);
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

    test('waitForFunction reports the last predicate error on timeout', async ({ backgroundPage }) => {
        await expect(
            backgroundPage.waitForFunction(
                () => {
                    throw new Error('predicate boom');
                },
                undefined,
                { timeout: 500, polling: 50 },
            ),
        ).rejects.toThrow(/Timed out after \d+ms waiting for function.*predicate boom/s);
    });
});
