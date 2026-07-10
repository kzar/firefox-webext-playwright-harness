# Firefox WebExtensions Playwright Harness

Experimental (and work in progress) support for testing Firefox browser extensions using Playwright.

We're working on this, to see if we can get the DuckDuckGo browser extension's integration tests
running against Firefox. I don't recommend using this for anything important for now, but I'm hoping
in the future we'll find the time to go through the code and tidy it up.

This package contains a number of hacks to workaround the
[lack of built-in support](https://github.com/microsoft/playwright/issues/7297):

- The **Remote Debugging Protocol (RDP)** is used to install extensions and to
  evaluate code in their background context. The RDP client is vendored from
  Mozilla's [web-ext](https://github.com/mozilla/web-ext) project.
- A privileged **XPCOM helper extension** observes network requests at the
  channel level and POSTs them to a local web server, and redirects the
  extension-under-test's background requests to it (Juggler can't intercept
  them the way Chrome's DevTools protocol can).
- Playwright's bundled Firefox is **patched in place** (`omni.ja` /
  `playwright.cfg`) to enable experiment APIs and let Juggler interact with
  `moz-extension://` pages.
- A `NetworkEventBridge` translates the XPCOM events into Playwright-style
  `requestfinished` / `requestfailed` events, and the `page` / `context` are
  wrapped in Proxies.

## Usage

1. Add this project as a dependency. (It is assumed your project uses Node.js >= 20 and already
   has the `@playwright/test` dependency.
2. Add a Playwright Firefox configuration, including some extra settings. For example:

```javascript
import { defineConfig } from '@playwright/test';
import path from 'path';

export default defineConfig({
    // ...
    // Patches Playwright's bundled Firefox once before workers start (omni.ja /
    // playwright.cfg), so the harness can drive the extension.
    globalSetup: 'firefox-webext-playwright-harness/globalSetup',
    use: {
        firefoxHarnessConfig: {
            // Absolute path to the built, unpacked Firefox extension to install.
            extensionPath: path.join(process.cwd(), 'build/firefox/dev'),
            // Optional ordered [from, to] rewrites applied to a redirected
            // request's reconstructed URL before your route handlers see it (e.g.
            // map a Firefox-only config filename to the one on disk). Omit for none.
            rewriteStaticRules: [['config-firefox.json', 'config.json']],
            // Optional URL patterns (substrings or RegExps) for tab(s) your extension
            // opens on install, e.g. a post-install page. The page fixture waits for
            // these to open (in the initial window) before the first newPage(), so they
            // can't race Juggler's new-window "exactly one tab" check. Omit for none.
            postInstallPages: ['https://example.com/extension-success'],
        },
    },
});
```

3. Ensure your harness / setup code calls `applyFirefoxHarness` for Firefox test runs. Something
like:

```javascript
import { applyFirefoxHarness } from 'firefox-webext-playwright-harness';

let test = base.extend({ /* your Chrome fixtures */ });

if (isFirefox()) {
    test = applyFirefoxHarness(test, {
        // Playwright route handler for the extension's pages and its redirected
        // background requests (typically the same one you use for Chrome).
        defaultRouteHandler,
    });
}

export { test };
```

### Route handlers for background requests

The extension's background `http(s)` requests are redirected to a local harness server that
runs the same Playwright-style route handlers you register with `context.route(...)`. The
`route` object passed to those handlers follows Playwright's `Route` contract:

- `route.fulfill({ status, headers, body })` — also supports `contentType`, `json`, and
  `path` (read from disk), with Playwright's precedence (`json`/`path` over `body`).
- `route.request()` — exposes `url()`, `method()`, `headers()`, `postData()`,
  `postDataBuffer()`, and `postDataJSON()`.
- `route.continue()` — sends the request to the real origin, **skipping any remaining
  handlers** (redirects are relayed to the extension, not silently followed).
- `route.fallback()` — defers to the next matching handler, then the base handler, then
  the origin.
- `route.abort([errorCode])` — fails the request (the extension's `fetch` rejects), rather
  than returning an empty success.

Only string glob patterns registered via `context.route()` are matched for background
requests; RegExp/function matchers apply to content-page requests only. `route()` options
(e.g. `{ times }`) are not applied to background requests.

Extensions using either `background.scripts` or `background.page` in their manifest are
supported.

## Standalone usage (without @playwright/test)

For cases where you just need to evaluate code in the extension's background context, e.g. unit
tests using `declarativeNetRequest.testMatchOutcome` or similar, you can use the
`launchExtensionBackground` function instead, which has less overhead.

```javascript
const { launchExtensionBackground } = require('firefox-webext-playwright-harness');

const { background, close } = await launchExtensionBackground({
    extensionPath: '/path/to/built/extension',
    firefoxUserPrefs: { 'extensions.dnr.feedback': true },
});

// `background` mimics Playwright's Worker/Page evaluate() contract.
const result = await background.evaluate(
    (details) => browser.declarativeNetRequest.testMatchOutcome(details),
    { url: 'https://tracker.example/script.js', type: 'script' },
);

await close();
```

Note: Pages opened in this browser are not routed or bridged, so they aren't usable for testing.
      If you need to drive pages or intercept requests, use `applyFirefoxHarness` instead.

## Running the tests

```sh
# Get set up.
npm install
npx playwright install firefox

# Unit tests for the RDP client and glob matching (no browser needed).
npm run test:unit

# Standalone launchExtensionBackground tests (stock, unpatched Firefox).
npm run test:standalone

# Run the Playwright test suite.
npm run playwright

# Stress-test to catch flakes.
npm run playwright -- --repeat-each=30 --workers=10
```

