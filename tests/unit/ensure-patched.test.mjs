// Unit tests for replaceExactlyOnce, the seam ensureFirefoxPatched uses to fail loudly
// when a Playwright Firefox build no longer matches a patch needle (rather than silently
// writing an unpatched omni.ja and marking it patched). Exercising the full omni.ja
// patch would need a real Firefox install, so only the pure helper is unit-tested.

import test from 'node:test';
import assert from 'node:assert/strict';

import { replaceExactlyOnce } from '../../src/harness.js';

test('replaces a single occurrence', () => {
    assert.equal(replaceExactlyOnce('a FALSE b', 'FALSE', 'TRUE', 'file'), 'a TRUE b');
});

test('throws a clear, build-incompatibility error when the needle is absent', () => {
    assert.throws(
        () => replaceExactlyOnce('nothing here', 'MISSING', 'x', 'omni.ja:foo'),
        /needle not found in omni\.ja:foo.*incompatible with this Playwright Firefox build/s,
    );
});

test('throws when the needle occurs more than once (ambiguous patch)', () => {
    assert.throws(
        () => replaceExactlyOnce('x DUP y DUP z', 'DUP', 'q', 'omni.ja:bar'),
        /occurs more than once in omni\.ja:bar.*incompatible with this Playwright Firefox build/s,
    );
});
