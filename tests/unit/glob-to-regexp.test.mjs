// Table-driven tests for the web server's glob matching, which must follow
// playwright-core 1.60's globToRegexPattern semantics so context.route() patterns
// behave identically for content-page requests (matched by Playwright) and
// XPCOM-redirected background requests (matched by the harness web server).

import test from 'node:test';
import assert from 'node:assert/strict';

import { globToRegExp } from '../../src/web-server.js';

const MATCHES = [
    // ** crosses path segments, * does not
    ['**/*.js', 'https://example.com/path/file.js'],
    ['https://example.com/*.js', 'https://example.com/file.js'],
    ['https://example.com/**/tracker.js', 'https://example.com/a/b/tracker.js'],
    // '/**/' also matches zero intermediate segments (Playwright: ((.+/)|))
    ['https://example.com/**/tracker.js', 'https://example.com/tracker.js'],
    // '?' is a literal question mark, not a single-char wildcard
    ['https://example.com/path?q=1', 'https://example.com/path?q=1'],
    // {a,b} groups expand to alternatives
    ['https://example.com/{one,two}.js', 'https://example.com/one.js'],
    ['https://example.com/{one,two}.js', 'https://example.com/two.js'],
    // backslash escapes a glob special
    ['https://example.com/a\\*b', 'https://example.com/a*b'],
    // URL normalisation (resolveGlobBase), matching Playwright: a bare origin
    // gains its trailing slash, hosts are case-insensitive, dot-segments resolve
    ['https://example.com', 'https://example.com/'],
    ['https://Example.COM/**', 'https://example.com/x'],
    ['https://example.com/a/../b/*', 'https://example.com/b/c'],
];

const NON_MATCHES = [
    // * must not cross path segments
    ['https://example.com/*.js', 'https://example.com/nested/file.js'],
    // '?' is literal
    ['https://example.com/path?q=1', 'https://example.com/pathXq=1'],
    // {a,b} does not match values outside the group
    ['https://example.com/{one,two}.js', 'https://example.com/three.js'],
    // escaped * is literal
    ['https://example.com/a\\*b', 'https://example.com/aXb'],
];

for (const [glob, url] of MATCHES) {
    test(`'${glob}' matches '${url}'`, () => {
        assert.equal(globToRegExp(glob).test(url), true);
    });
}

for (const [glob, url] of NON_MATCHES) {
    test(`'${glob}' does not match '${url}'`, () => {
        assert.equal(globToRegExp(glob).test(url), false);
    });
}

test('malformed brace groups throw like Playwright', () => {
    assert.throws(() => globToRegExp('https://x/{a,{b,c}}'), /nested '\{' is not supported/);
    assert.throws(() => globToRegExp('https://x/a}b'), /unmatched '\}'/);
    assert.throws(() => globToRegExp('https://x/{a,b'), /unmatched '\{'/);
});
