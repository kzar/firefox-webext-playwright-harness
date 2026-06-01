const { ensureFirefoxPatched } = require('./harness.js');

/**
 * Playwright globalSetup hook for the Firefox runner. Runs once in the main
 * process before any worker processes spawn, so the omni.ja / playwright.cfg
 * patches are applied without a worker-vs-worker read/write race.
 */
module.exports = async function globalSetup() {
    await ensureFirefoxPatched();
};
