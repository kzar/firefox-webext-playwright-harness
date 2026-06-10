import { test as base, expect } from '@playwright/test';
import { applyFirefoxHarness } from 'firefox-webext-playwright-harness';

// This repo only ever exercises the harness (Firefox), so always layer it on —
// no isFirefox() branch like a cross-browser consumer would need. The default
// route handler just lets requests through; individual specs register their own
// routes when they need to mock a response.
const test = applyFirefoxHarness(base, {
    defaultRouteHandler: (route) => route.continue(),
});

export { test, expect };
