const fs = require('fs/promises');
const fsSync = require('fs');
const os = require('os');
const path = require('path');
const JSZip = require('jszip');
const { firefox } = require('@playwright/test');
const { connectToFirefox, findFreeTcpPort } = require('./web-ext-rdp.js');
const { FirefoxWebServer } = require('./web-server.js');

function ensureTempPath(dirOrFilePath) {
    if (path.relative(os.tmpdir(), dirOrFilePath).startsWith('..')) {
        throw new Error(`ensureTempPath check failed! Path: "${path.resolve(dirOrFilePath)}"`);
    }
}

function rmTempDir(dirPath) {
    ensureTempPath(dirPath);
    return fs.rm(dirPath, { recursive: true, force: true });
}

function rmTempDirSync(dirPath) {
    ensureTempPath(dirPath);
    fsSync.rmSync(dirPath, { recursive: true, force: true });
}

// Track temp directories so they're cleaned up even if the process is killed
// (e.g. Playwright worker teardown timeout).
const _tempDirs = new Set();
process.on('exit', () => {
    for (const dir of _tempDirs) {
        try {
            rmTempDirSync(dir);
        } catch {
            // Best-effort cleanup
        }
    }
});

const helperExtensionPath = path.join(__dirname, 'xpcom-extension');

const CFG_MARKER = '// --- Firefox Playwright Harness ---';

let _firefoxPatched = false;
/**
 * Patch Playwright's Firefox installation in-place to enable experiment_apis
 * and allow Juggler to interact with moz-extension:// pages.
 *
 * Playwright's bundled Firefox has Cu.isInAutomation permanently false, which
 * makes AddonSettings.EXPERIMENTS_ENABLED a hardcoded constant false in
 * AddonSettings.sys.mjs. This prevents the XPCOM helper extension from loading
 * its experiment_apis.
 *
 * We patch three files (idempotently, using a marker in playwright.cfg):
 * 1. omni.ja — flip EXPERIMENTS_ENABLED from false to true
 * 2. omni.ja — neuter JugglerFrameChild.jsm's moz-extension:// early return
 *    so Juggler can interact with extension pages opened as tabs
 * 3. playwright.cfg — lock marionette.running so Cu.isInAutomation returns
 *    true at runtime, enabling experiment API execution
 */
async function ensureFirefoxPatched() {
    if (_firefoxPatched) return;

    const binDir = path.dirname(firefox.executablePath());
    // macOS packages Firefox as an .app bundle: the binary lives in
    // Contents/MacOS while playwright.cfg and omni.ja live in Contents/Resources.
    // On Linux/Windows the binary and these resources share one directory.
    const firefoxDir = process.platform === 'darwin' ? path.join(binDir, '..', 'Resources') : binDir;
    const cfgPath = path.join(firefoxDir, 'playwright.cfg');
    const cfgContent = await fs.readFile(cfgPath, 'utf8');

    if (!cfgContent.includes(CFG_MARKER)) {
        // Patch omni.ja: enable EXPERIMENTS_ENABLED in AddonSettings.sys.mjs.
        const omniPath = path.join(firefoxDir, 'omni.ja');
        const zip = await JSZip.loadAsync(await fs.readFile(omniPath));
        const addonSettingsFile = zip.file('modules/addons/AddonSettings.sys.mjs');
        if (!addonSettingsFile) throw new Error('AddonSettings.sys.mjs not found in omni.ja');
        const addonSettings = await addonSettingsFile.async('string');
        zip.file(
            'modules/addons/AddonSettings.sys.mjs',
            addonSettings.replace('makeConstant("EXPERIMENTS_ENABLED", false)', 'makeConstant("EXPERIMENTS_ENABLED", true)'),
        );
        // Patch JugglerFrameChild.jsm: neuter the moz-extension:// early return so
        // Juggler can interact with extension pages opened as tabs.
        const jugglerChildFile = zip.file('chrome/juggler/content/content/JugglerFrameChild.jsm');
        if (!jugglerChildFile) throw new Error('JugglerFrameChild.jsm not found in omni.ja');
        const jugglerChild = await jugglerChildFile.async('string');
        zip.file(
            'chrome/juggler/content/content/JugglerFrameChild.jsm',
            jugglerChild.replace('moz-extension://', 'moz-extension-DISABLED://'),
        );

        await fs.writeFile(omniPath, await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' }));

        // Patch playwright.cfg: lock marionette.running for runtime experiment support.
        await fs.writeFile(
            cfgPath,
            cfgContent +
                ['', CFG_MARKER, 'lockPref("marionette.running", true);', '// --- End Firefox Playwright Harness ---'].join('\n') +
                '\n',
        );
    }

    _firefoxPatched = true;
}

/**
 * Wait for the `evaluationResult` RDP event carrying `resultID` and resolve with it.
 *
 * Results arrive as unsolicited `evaluationResult` events, which connectExtensionRdp()
 * buffers into `evalResults` and re-emits on the client as `evaluationResult:<resultID>`.
 * We resolve the moment that event fires (push) rather than polling, falling back to
 * the buffer for the rare case the event landed before we started waiting.
 */
function waitForEvaluationResult(client, evalResults, resultID, timeoutMs) {
    return new Promise((resolve, reject) => {
        // The result may already have arrived between sending the request and now.
        if (evalResults.has(resultID)) {
            const buffered = evalResults.get(resultID);
            evalResults.delete(resultID);
            resolve(buffered);
            return;
        }
        const eventName = `evaluationResult:${resultID}`;
        const onResult = (message) => {
            clearTimeout(timer);
            evalResults.delete(resultID);
            resolve(message);
        };
        const timer = setTimeout(() => {
            client.off(eventName, onResult);
            const connState = client._rdpConnection ? 'connected' : 'disconnected';
            reject(new Error(`Timeout waiting for evaluation result (resultID: ${resultID}, conn: ${connState})`));
        }, timeoutMs);
        client.once(eventName, onResult);
    });
}

/**
 * Send an evaluateJSAsync request and return its acknowledgement, which carries the
 * resultID the eventual evaluationResult event is keyed by.
 */
async function sendEvaluate(client, consoleActor, text) {
    let request;
    try {
        request = await client.request({ to: consoleActor, type: 'evaluateJSAsync', text });
    } catch (e) {
        throw new Error(`RDP evaluateJSAsync request failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!request.resultID) {
        throw new Error(`RDP evaluateJSAsync did not return a resultID: ${JSON.stringify(request)}`);
    }
    return request;
}

/**
 * Read an evaluationResult's value as a string.
 */
async function readResultString(client, result) {
    const value = result.result;
    if (typeof value !== 'string') {
        throw new Error(`Unexpected result type: ${typeof value}`);
    }
    return value;
}

/**
 * Evaluate JavaScript code in the Firefox extension's background page via RDP and
 * return its result.
 *
 * evaluateJSAsync does NOT await a promise the evaluated expression returns — it hands
 * back a grip of the still-pending promise — so a promise result is resolved with a small
 * dance: the evaluated code stashes the settled, JSON-serialised value on a globalThis
 * slot which we read back until it's ready. A fixed slot is safe (never needs cleanup)
 * because evaluate() calls are serialised per background page (FirefoxBackgroundPage._evalLock).
 * Synchronous results are returned inline. Every round-trip's result is awaited via push
 * (waitForEvaluationResult) rather than polled.
 */
async function evaluateInFirefoxBackground(client, consoleActor, evalResults, code) {
    if (!consoleActor) {
        throw new Error('No background console actor available');
    }

    // Check if the client is still connected (web-ext uses _rdpConnection)
    if (!client._rdpConnection) {
        throw new Error('RDP client is not connected');
    }

    const wrappedCode = `
        (function () {
            try {
                var __result__ = (function () { return (${code}); })();
                if (__result__ && typeof __result__.then === 'function') {
                    globalThis.__ddgHarnessEval = { pending: true };
                    Promise.resolve(__result__).then(
                        function (value) {
                            globalThis.__ddgHarnessEval = { pending: false, value: JSON.stringify({ __ok__: true, __value__: value }) };
                        },
                        function (error) {
                            globalThis.__ddgHarnessEval = { pending: false, value: JSON.stringify({ __ok__: false, __error__: (error && error.message) || String(error) }) };
                        },
                    );
                    return JSON.stringify({ __pending__: true });
                }
                return JSON.stringify({ __ok__: true, __value__: __result__ });
            } catch (error) {
                return JSON.stringify({ __ok__: false, __error__: (error && error.message) || String(error) });
            }
        })()
    `;

    const evalRequest = await sendEvaluate(client, consoleActor, wrappedCode);
    const result = await waitForEvaluationResult(client, evalResults, evalRequest.resultID, 30000);
    if (result.hasException) {
        throw new Error(`Evaluation error: ${result.exceptionMessage}`);
    }
    const parsed = JSON.parse(await readResultString(client, result));

    // Synchronous result — done.
    if (!parsed.__pending__) {
        if (!parsed.__ok__) {
            throw new Error(`Evaluation error: ${parsed.__error__}`);
        }
        return parsed.__value__;
    }

    // Promise result — read the slot back until the promise has settled.
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
        const checkRequest = await sendEvaluate(client, consoleActor, 'JSON.stringify(globalThis.__ddgHarnessEval)');
        const checkResult = await waitForEvaluationResult(client, evalResults, checkRequest.resultID, 30000);
        if (checkResult.hasException) {
            throw new Error(`Async check error: ${checkResult.exceptionMessage}`);
        }
        const slot = JSON.parse(await readResultString(client, checkResult));
        if (slot && !slot.pending) {
            const finalParsed = JSON.parse(slot.value);
            if (!finalParsed.__ok__) {
                throw new Error(`Evaluation error: ${finalParsed.__error__}`);
            }
            return finalParsed.__value__;
        }
        // Not settled yet (rare for a fast promise) — brief backoff before re-reading.
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('Timeout waiting for async evaluation result');
}

/**
 * Wrapper class providing background page functionality for Firefox via RDP.
 * Provides an API similar to Playwright's Page/Worker for evaluate() calls.
 *
 * Important: All evaluate() calls are serialized via a lock to prevent RDP
 * concurrency issues where evaluation results can arrive out of order.
 */
class FirefoxBackgroundPage {
    constructor(rdpClient, consoleActor, evalResults) {
        this._client = rdpClient;
        this._consoleActor = consoleActor;
        this._evalResults = evalResults;
        this._evalLock = Promise.resolve(); // Lock for serializing evaluate calls
    }

    async evaluate(pageFunction, ...args) {
        if (!this._consoleActor) {
            throw new Error('Firefox background page not available');
        }
        let code;
        if (typeof pageFunction === 'function') {
            const fnStr = pageFunction.toString();
            if (args.length > 0) {
                const serializedArgs = args.map((arg) => JSON.stringify(arg)).join(', ');
                code = `(${fnStr})(${serializedArgs})`;
            } else {
                code = `(${fnStr})()`;
            }
        } else {
            code = String(pageFunction);
        }
        // Serialize all evaluate calls to prevent RDP concurrency issues
        const prevLock = this._evalLock;
        /** @type {(value?: unknown) => void} */
        let releaseLock = () => {};
        this._evalLock = new Promise((resolve) => {
            releaseLock = resolve;
        });
        try {
            await prevLock;
            return await evaluateInFirefoxBackground(this._client, this._consoleActor, this._evalResults, code);
        } finally {
            releaseLock();
        }
    }

    // Playwright signature: (pageFunction, arg, options). backgroundWait.js
    // (forFunction/forSetting) calls this Playwright-style.
    async waitForFunction(pageFunction, arg, options = {}) {
        const { timeout = 30000, polling = 100 } = options;
        const startTime = Date.now();
        while (true) {
            try {
                const result = await this.evaluate(pageFunction, arg);
                if (result) return result;
            } catch (e) {
                // Ignore errors during polling
            }
            if (Date.now() - startTime > timeout) {
                throw new Error('Timeout waiting for function');
            }
            await new Promise((resolve) => setTimeout(resolve, polling));
        }
    }

    routeFromHAR() {
        throw new Error('routeFromHAR is not supported for Firefox background page');
    }
}

/**
 * Install the XPCOM helper extension via RDP (no background page access needed).
 * Writes a config.json with the server port before installing.
 */
async function installHelperExtension(client, addonsActor, serverPort) {
    // Copy helper extension to a temp dir and write config.json with server port
    const tmpDir = await fs.mkdtemp(`${os.tmpdir()}/fx-harness-helper-`);
    _tempDirs.add(tmpDir);
    const srcFiles = await fs.readdir(helperExtensionPath);
    for (const file of srcFiles) {
        await fs.copyFile(path.join(helperExtensionPath, file), path.join(tmpDir, file));
    }
    await fs.writeFile(path.join(tmpDir, 'config.json'), JSON.stringify({ port: serverPort }));

    await client.request({
        to: addonsActor,
        type: 'installTemporaryAddon',
        addonPath: tmpDir,
    });

    return tmpDir;
}

/**
 * Create a Firefox browser context with extension support.
 *
 * Install sequence:
 * 1. Start FirefoxWebServer
 * 2. Launch Firefox (using patched overlay for experiment_apis support)
 * 3. Connect via RDP
 * 4. Install XPCOM helper extension (observers active before the extension fetches config)
 * 5. Wait for helper's ready event
 * 6. Install the extension under test
 * 7. Get the extension's background console actor
 */
/**
 * Firefox user prefs the harness requires to install and drive the extension over RDP.
 * Layered on top of any consumer-supplied `launchOptions.firefoxUserPrefs` so consumer
 * prefs still apply, but these are never clobbered.
 */
const HARNESS_REQUIRED_PREFS = {
    'xpinstall.signatures.required': false,
    'extensions.autoDisableScopes': 0,
    'extensions.enabledScopes': 15,
    'devtools.debugger.remote-enabled': true,
    'devtools.debugger.prompt-connection': false,
    // Playwright's bundled Firefox sets dom.ipc.processCount to 60000 in playwright.cfg
    // (line 44), forcing every tab into its own content process. This causes severe IPC
    // latency degradation when multiple tabs are open. Cap at 8 (Firefox's default) so
    // tabs share processes.
    'dom.ipc.processCount': 8,
};

/**
 * Build the options for `firefox.launchPersistentContext` from the standard Playwright
 * `use` options the consumer set, layering the harness's invariants on top. The harness
 * must run Playwright's bundled Firefox (patched in place by `ensureFirefoxPatched`) and
 * needs the RDP debugger arg plus the extension prefs, so those always win; everything
 * else (headless, slowMo, viewport, ...) is passed through to behave like a normal
 * Playwright project.
 *
 * @param {number} rdpPort - Port for Firefox's remote debugging server.
 * @param {object} [playwrightOptions] - Resolved Playwright option-fixture values,
 *   forwarded from the `context` fixture.
 * @param {boolean} [playwrightOptions.headless]
 * @param {object} [playwrightOptions.launchOptions]
 * @param {object|null} [playwrightOptions.viewport]
 * @param {string} [playwrightOptions.userAgent]
 * @param {string} [playwrightOptions.locale]
 * @param {string} [playwrightOptions.timezoneId]
 * @param {string} [playwrightOptions.colorScheme]
 */
function buildFirefoxLaunchOptions(rdpPort, playwrightOptions = {}) {
    const {
        headless,
        launchOptions = {},
        viewport,
        userAgent,
        locale,
        timezoneId,
        colorScheme,
    } = playwrightOptions;

    // The harness patches Playwright's bundled Firefox in place, so it can't run a
    // different binary or release channel. Fail fast rather than silently ignoring.
    for (const unsupported of ['executablePath', 'channel']) {
        if (launchOptions[unsupported] != null) {
            throw new Error(
                `The Firefox harness can't honour launchOptions.${unsupported}: it must run ` +
                    "Playwright's bundled Firefox, which is patched in place to drive the extension.",
            );
        }
    }

    return {
        // Context options (top-level Playwright shortcuts). When unset these resolve to
        // Playwright's own defaults, so passing them through leaves behaviour unchanged.
        viewport,
        userAgent,
        locale,
        timezoneId,
        colorScheme,
        // Pass-through launch options.
        slowMo: launchOptions.slowMo,
        devtools: launchOptions.devtools,
        timeout: launchOptions.timeout,
        env: launchOptions.env,
        // The resolved `headless` fixture already folds in `launchOptions.headless`, with
        // the top-level `use: { headless }` shortcut winning (Playwright's own precedence).
        headless,
        // Harness invariants — always win over consumer-supplied values.
        executablePath: firefox.executablePath(),
        firefoxUserPrefs: {
            ...launchOptions.firefoxUserPrefs,
            ...HARNESS_REQUIRED_PREFS,
        },
        args: [...(launchOptions.args || []), `-start-debugger-server=${rdpPort}`],
    };
}

/**
 * Connect to Firefox's Remote Debugging Protocol server and gather the pieces every
 * extension-driving code path needs: an RDP client with a listener collecting
 * evaluation results and worker targets, plus the root addons actor used to install
 * temporary add-ons. The caller owns cleanup (client.disconnect()) once this resolves.
 */
async function connectExtensionRdp(rdpPort) {
    const client = await connectToFirefox(rdpPort);
    const evalResults = new Map();
    const workerTargets = [];
    client.on('unsolicited-event', (msg) => {
        if (msg.type === 'evaluationResult') {
            // Buffer the result (in case a waiter hasn't attached yet) and notify any
            // active waiter immediately — waitForEvaluationResult() resolves on this
            // event rather than polling the map.
            evalResults.set(msg.resultID, msg);
            client.emit(`evaluationResult:${msg.resultID}`, msg);
        }
        if (msg.type === 'target-available-form' && msg.target && msg.target.url) {
            workerTargets.push(msg.target);
        }
    });

    try {
        const rootInfo = await client.request('getRoot');
        const addonsActor = rootInfo.addonsActor;
        if (!addonsActor) {
            throw new Error('Firefox does not provide an addons actor');
        }
        return { client, evalResults, workerTargets, addonsActor };
    } catch (err) {
        client.disconnect();
        throw err;
    }
}

/**
 * Install the extension under test as a temporary add-on and find the console actor
 * for its background page, so that code can be evaluated in the background context.
 * @param {object} rdp - The result of connectExtensionRdp().
 * @param {string} extensionPath - Absolute path to the built, unpacked extension.
 * @param {string} addonId - The extension's add-on ID (from its manifest).
 */
async function installExtensionAndFindBackground(rdp, extensionPath, addonId) {
    const { client, workerTargets, addonsActor } = rdp;

    const installResult = await client.request({
        to: addonsActor,
        type: 'installTemporaryAddon',
        addonPath: extensionPath,
    });

    let ourAddon = null;
    const maxAddonRetries = 10;
    for (let attempt = 0; attempt < maxAddonRetries; attempt++) {
        const addonsResponse = await client.request('listAddons');
        ourAddon = addonsResponse.addons.find((a) => a.id === addonId);
        if (ourAddon) break;
        await new Promise((resolve) => setTimeout(resolve, 300));
    }
    if (!ourAddon) {
        throw new Error(`Could not find addon ${addonId} after ${maxAddonRetries} attempts`);
    }

    const watcherResult = await client.request({
        to: ourAddon.actor,
        type: 'getWatcher',
    });

    await client.request({
        to: watcherResult.actor,
        type: 'watchTargets',
        targetType: 'frame',
    });

    const workerResult = await client.request({
        to: watcherResult.actor,
        type: 'watchTargets',
        targetType: 'worker',
    });

    let backgroundConsoleActor = null;
    if (workerResult.target && workerResult.target.url && workerResult.target.url.includes('_generated_background_page')) {
        backgroundConsoleActor = workerResult.target.consoleActor;
    }

    if (!backgroundConsoleActor) {
        const maxTargetRetries = 20;
        for (let attempt = 0; attempt < maxTargetRetries; attempt++) {
            const bgTarget = workerTargets.find((t) => t.url && t.url.includes('_generated_background_page'));
            if (bgTarget && bgTarget.consoleActor) {
                backgroundConsoleActor = bgTarget.consoleActor;
                break;
            }
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
    }

    if (!backgroundConsoleActor) {
        throw new Error(`Could not find background console actor for ${addonId}`);
    }

    await client.request({
        to: backgroundConsoleActor,
        type: 'startListeners',
        listeners: ['evaluationResult'],
    });

    return { addon: installResult.addon, backgroundConsoleActor };
}

/**
 * @param {object} [options]
 * @param {function} [options.routeHandler] - Playwright-style handler for the extension's
 *   redirected background requests.
 * @param {Array<[string, string]>} [options.rewriteStaticRules] - Ordered [from, to] rewrites
 *   applied to a redirected request's reconstructed URL.
 * @param {object} [options.playwrightOptions] - Resolved standard Playwright `use` options
 *   (headless, launchOptions, viewport, ...) forwarded from the `context` fixture.
 */
async function createFirefoxContext(rdpPort, extensionPath, addonId, options = {}) {
    const { routeHandler, rewriteStaticRules, playwrightOptions } = options;
    // 1. Start local web server
    const server = new FirefoxWebServer();
    await server.start();
    if (rewriteStaticRules) {
        server.setRewriteStaticRules(rewriteStaticRules);
    }
    if (routeHandler) {
        server.setRouteHandler(routeHandler);
    }

    // 2. Launch Firefox
    const userDataDir = await fs.mkdtemp(`${os.tmpdir()}/firefox-test-`);
    _tempDirs.add(userDataDir);

    // Patch playwright.cfg to enable experiment_apis
    await ensureFirefoxPatched();

    const context = await firefox.launchPersistentContext(
        userDataDir,
        buildFirefoxLaunchOptions(rdpPort, playwrightOptions),
    );

    // 3. Connect via RDP
    let rdp;
    try {
        rdp = await connectExtensionRdp(rdpPort);
    } catch (err) {
        await server.stop();
        await withTimeout(context.close(), 10000);
        await rmTempDir(userDataDir).catch(() => {});
        _tempDirs.delete(userDataDir);
        throw err;
    }
    const { client, evalResults, addonsActor } = rdp;

    let helperTmpDir;
    try {
        // 4. Install helper extension FIRST (so XPCOM observers are active before the extension fetches config)
        helperTmpDir = await installHelperExtension(client, addonsActor, server.port);

        // 5. Wait for helper's ready event
        await server.waitForEvent((e) => e.type === 'ready', 10000);

        // 6 + 7. Install the extension under test and find its background console actor
        const { addon, backgroundConsoleActor } = await installExtensionAndFindBackground(rdp, extensionPath, addonId);

        // Store for cleanup. Cast context to allow stashing private fields.
        const ctx = /** @type {any} */ (context);
        ctx._firefoxUserDataDir = userDataDir;
        ctx._firefoxHelperTmpDir = helperTmpDir;
        ctx._rdpClient = client;
        ctx._firefoxBackgroundConsoleActor = backgroundConsoleActor;
        ctx._firefoxEvalResults = evalResults;
        ctx._firefoxWebServer = server;

        return {
            context,
            rdpResult: {
                addon,
                client,
                backgroundConsoleActor,
                evalResults,
            },
        };
    } catch (err) {
        client.disconnect();
        await server.stop();
        await withTimeout(context.close(), 10000);
        if (helperTmpDir) {
            await rmTempDir(helperTmpDir).catch(() => {});
        }
        await rmTempDir(userDataDir).catch(() => {});
        _tempDirs.delete(userDataDir);
        throw err;
    }
}

// Resolve `promise` or null after `ms` so a wedged Firefox / RDP / fs op can't
// burn the whole 60s teardown budget on one stuck await.
function withTimeout(promise, ms) {
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(resolve, ms); });
    return Promise.race([promise.catch(() => null), timeout]).finally(() => clearTimeout(timer));
}

/**
 * Clean up Firefox context resources
 */
async function cleanupFirefoxContext(context) {
    // Stop the web server first
    if (context._firefoxWebServer) {
        await withTimeout(context._firefoxWebServer.stop(), 5000);
        context._firefoxWebServer = null;
    }

    // Disconnect RDP (web-ext client has disconnect() method)
    if (context._rdpClient) {
        try {
            context._rdpClient.disconnect();
        } catch (e) {
            // Ignore disconnect errors
        }
        context._rdpClient = null;
    }

    // Clear the evalResults map to prevent any stale state
    if (context._firefoxEvalResults) {
        context._firefoxEvalResults.clear();
        context._firefoxEvalResults = null;
    }

    // Close the browser context
    await withTimeout(context.close(), 10000);

    // Wait for browser to fully shut down
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Clean up temp directories
    for (const dir of [context._firefoxUserDataDir, context._firefoxHelperTmpDir]) {
        if (dir) {
            try {
                await withTimeout(rmTempDir(dir), 5000);
            } catch (e) {
                const message = e instanceof Error ? e.message : String(e);
                console.warn(`cleanupFirefoxContext: failed to remove ${dir}: ${message}`);
            }
            _tempDirs.delete(dir);
        }
    }
}

/**
 * Launch Playwright's bundled Firefox, install the given extension as a temporary
 * add-on and return a handle for evaluating code in the extension's background
 * context — nothing else.
 *
 * This is the standalone (non-@playwright/test) entry point, for tooling that only
 * needs a background `evaluate()` — for example a Puppeteer-style test interface
 * that loads declarativeNetRequest rules and checks testMatchOutcome results. Unlike
 * the `applyFirefoxHarness` fixtures, no omni.ja patching (globalSetup), XPCOM
 * helper extension or network interception is involved; this runs against the stock
 * bundled Firefox. The trade-off is that pages opened in the browser are not routed
 * or bridged — if you need to drive pages or intercept requests, use
 * `applyFirefoxHarness` instead.
 *
 * @param {object} options
 * @param {string} options.extensionPath - Absolute path to the built, unpacked extension.
 * @param {string} options.addonId - The extension's add-on ID (from its manifest).
 * @param {boolean} [options.headless] - Defaults to Playwright's default (headless).
 * @param {object} [options.firefoxUserPrefs] - Extra Firefox preferences, e.g.
 *   `{ 'extensions.dnr.feedback': true }`. The harness's required preferences are
 *   layered on top and always win.
 * @param {string[]} [options.args] - Extra Firefox command line arguments.
 * @returns {Promise<{ background: FirefoxBackgroundPage, close: () => Promise<void> }>}
 */
async function launchExtensionBackground({ extensionPath, addonId, headless, firefoxUserPrefs, args }) {
    const rdpPort = await findFreeTcpPort();

    const userDataDir = await fs.mkdtemp(`${os.tmpdir()}/firefox-ext-background-`);
    _tempDirs.add(userDataDir);

    const context = await firefox.launchPersistentContext(
        userDataDir,
        buildFirefoxLaunchOptions(rdpPort, { headless, launchOptions: { firefoxUserPrefs, args } }),
    );

    let client = null;
    try {
        const rdp = await connectExtensionRdp(rdpPort);
        client = rdp.client;

        const { backgroundConsoleActor } = await installExtensionAndFindBackground(rdp, extensionPath, addonId);
        const background = new FirefoxBackgroundPage(client, backgroundConsoleActor, rdp.evalResults);

        let closed = false;
        const close = async () => {
            if (closed) return;
            closed = true;
            try {
                client.disconnect();
            } catch {
                // Ignore disconnect errors
            }
            rdp.evalResults.clear();
            await withTimeout(context.close(), 10000);
            await rmTempDir(userDataDir).catch(() => {});
            _tempDirs.delete(userDataDir);
        };

        return { background, close };
    } catch (err) {
        if (client) {
            try {
                client.disconnect();
            } catch {
                // Ignore disconnect errors
            }
        }
        await withTimeout(context.close(), 10000);
        await rmTempDir(userDataDir).catch(() => {});
        _tempDirs.delete(userDataDir);
        throw err;
    }
}

module.exports = {
    ensureFirefoxPatched,
    FirefoxBackgroundPage,
    createFirefoxContext,
    cleanupFirefoxContext,
    launchExtensionBackground,
};
