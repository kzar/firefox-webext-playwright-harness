// Minimal test extension for the Firefox harness integration tests.
//
// This file is intentionally identical in extension-mv2/ and extension-mv3/ —
// keep the two copies in sync.
//
// Responsibilities:
//  - Cancel any request whose URL contains "/blocked", so the network spec can
//    observe a cancelled request surface as a 'requestfailed' event.
//  - Expose globalThis.__ready once the blocking listener is registered, so
//    specs can wait before relying on it.
//
// Background-script eval and the config-fetch routing/rewrite checks are driven
// directly from the tests via backgroundPage.evaluate(), so nothing extra is
// needed here for those.

browser.webRequest.onBeforeRequest.addListener(
    (details) => ({ cancel: details.url.includes('/blocked') }),
    { urls: ['<all_urls>'] },
    ['blocking'],
);

globalThis.__ready = true;
