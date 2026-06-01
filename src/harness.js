const fs = require('fs/promises');
const fsSync = require('fs');
const os = require('os');
const path = require('path');
const JSZip = require('jszip');
const { firefox } = require('@playwright/test');
const { connectToFirefox } = require('./web-ext-rdp.js');
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
 * Evaluate JavaScript code in the Firefox extension's background page via RDP.
 * Handles async/Promise results using a callback mechanism.
 */
async function evaluateInFirefoxBackground(client, consoleActor, evalResults, code) {
    if (!consoleActor) {
        throw new Error('No background console actor available');
    }

    // Check if the client is still connected (web-ext uses _rdpConnection)
    if (!client._rdpConnection) {
        throw new Error('RDP client is not connected');
    }

    const callbackId = `__evalCallback_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    const wrappedCode = `
        (function() {
            try {
                let __result__ = (function() { return ${code}; })();
                if (__result__ && typeof __result__.then === 'function') {
                    globalThis.${callbackId} = { pending: true };
                    __result__.then(function(val) {
                        globalThis.${callbackId} = { pending: false, value: JSON.stringify({ __ok__: true, __value__: val }) };
                    }).catch(function(e) {
                        globalThis.${callbackId} = { pending: false, value: JSON.stringify({ __ok__: false, __error__: e.message }) };
                    });
                    return JSON.stringify({ __pending__: true, __callbackId__: ${JSON.stringify(callbackId)} });
                }
                return JSON.stringify({ __ok__: true, __value__: __result__ });
            } catch (e) {
                return JSON.stringify({ __ok__: false, __error__: e.message });
            }
        })()
    `;

    let evalRequest;
    try {
        evalRequest = await client.request({
            to: consoleActor,
            type: 'evaluateJSAsync',
            text: wrappedCode,
        });
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        throw new Error(`RDP evaluateJSAsync request failed: ${message}`);
    }

    if (!evalRequest.resultID) {
        throw new Error(`RDP evaluateJSAsync did not return a resultID: ${JSON.stringify(evalRequest)}`);
    }

    const timeout = 30000;
    const startTime = Date.now();
    while (!evalResults.has(evalRequest.resultID)) {
        if (Date.now() - startTime > timeout) {
            // Check if connection is still active (web-ext uses _rdpConnection)
            const connState = client._rdpConnection ? 'connected' : 'disconnected';
            const pendingCount = evalResults.size;
            const existingResultIds = Array.from(evalResults.keys()).join(', ');
            throw new Error(
                `Timeout waiting for evaluation result (resultID: ${evalRequest.resultID}, conn: ${connState}, pendingResults: ${pendingCount}, existingIds: [${existingResultIds}])`,
            );
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const result = evalResults.get(evalRequest.resultID);
    evalResults.delete(evalRequest.resultID);

    if (result.hasException) {
        throw new Error(`Evaluation error: ${result.exceptionMessage}`);
    }

    const resultValue = result.result;
    if (typeof resultValue === 'object' && resultValue !== null) {
        if (resultValue.type === 'undefined') return undefined;
        if (typeof resultValue.value !== 'undefined') return resultValue.value;
    }
    if (typeof resultValue !== 'string') {
        throw new Error(`Unexpected result type: ${typeof resultValue}`);
    }

    const parsed = JSON.parse(resultValue);

    // Handle pending async result
    if (parsed.__pending__) {
        const pendingCallbackId = parsed.__callbackId__;
        const asyncTimeout = 30000;
        const asyncStartTime = Date.now();
        while (Date.now() - asyncStartTime < asyncTimeout) {
            const checkCode = `JSON.stringify(globalThis.${pendingCallbackId})`;
            const checkRequest = await client.request({
                to: consoleActor,
                type: 'evaluateJSAsync',
                text: checkCode,
            });
            while (!evalResults.has(checkRequest.resultID)) {
                if (Date.now() - asyncStartTime > asyncTimeout) {
                    throw new Error('Timeout waiting for async result');
                }
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
            const checkResult = evalResults.get(checkRequest.resultID);
            evalResults.delete(checkRequest.resultID);
            if (checkResult.hasException) {
                throw new Error(`Async check error: ${checkResult.exceptionMessage}`);
            }
            // Firefox RDP may wrap the result in a `{ type, value }` grip the
            // same way the initial result handler above unwraps. Mirror that
            // logic so a wrapped value isn't mistaken for "callback not set".
            let checkStr = checkResult.result;
            if (typeof checkStr === 'object' && checkStr !== null && typeof checkStr.value !== 'undefined') {
                checkStr = checkStr.value;
            }
            if (typeof checkStr === 'string') {
                const checkParsed = JSON.parse(checkStr);
                if (!checkParsed.pending) {
                    // Clean up - must await and consume the evaluationResult to avoid leftover results
                    const cleanupRequest = await client.request({
                        to: consoleActor,
                        type: 'evaluateJSAsync',
                        text: `delete globalThis.${pendingCallbackId}`,
                    });
                    // Wait for and consume the cleanup's evaluationResult
                    const cleanupTimeout = Date.now() + 5000;
                    while (!evalResults.has(cleanupRequest.resultID)) {
                        if (Date.now() > cleanupTimeout) break; // Don't block forever on cleanup
                        await new Promise((resolve) => setTimeout(resolve, 50));
                    }
                    evalResults.delete(cleanupRequest.resultID);

                    const finalParsed = JSON.parse(checkParsed.value);
                    if (!finalParsed.__ok__) {
                        throw new Error(`Evaluation error: ${finalParsed.__error__}`);
                    }
                    return finalParsed.__value__;
                }
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error('Timeout waiting for async evaluation result');
    }

    if (!parsed.__ok__) {
        throw new Error(`Evaluation error: ${parsed.__error__}`);
    }
    return parsed.__value__;
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
 * @param {object} [options]
 * @param {function} [options.routeHandler] - Playwright-style handler for the extension's
 *   redirected background requests.
 * @param {Array<[string, string]>} [options.rewriteStaticRules] - Ordered [from, to] rewrites
 *   applied to a redirected request's reconstructed URL.
 */
async function createFirefoxContext(rdpPort, extensionPath, addonId, options = {}) {
    const { routeHandler, rewriteStaticRules } = options;
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

    const context = await firefox.launchPersistentContext(userDataDir, {
        headless: true,
        executablePath: firefox.executablePath(),
        firefoxUserPrefs: {
            'xpinstall.signatures.required': false,
            'extensions.autoDisableScopes': 0,
            'extensions.enabledScopes': 15,
            'devtools.debugger.remote-enabled': true,
            'devtools.debugger.prompt-connection': false,
            // Playwright's bundled Firefox sets dom.ipc.processCount to 60000
            // in playwright.cfg (line 44), forcing every tab into its own
            // content process. This causes severe IPC latency degradation
            // when multiple tabs are open. Cap at 8 (Firefox's default) so
            // tabs share processes.
            'dom.ipc.processCount': 8,
        },
        args: [`-start-debugger-server=${rdpPort}`],
    });

    // 3. Connect via RDP
    const client = await connectToFirefox(rdpPort);
    const evalResults = new Map();
    const workerTargets = [];
    const targetListener = (msg) => {
        if (msg.type === 'evaluationResult') {
            evalResults.set(msg.resultID, msg);
        }
        if (msg.type === 'target-available-form' && msg.target && msg.target.url) {
            workerTargets.push(msg.target);
        }
    };
    client.on('unsolicited-event', targetListener);

    let helperTmpDir;
    try {
        const rootInfo = await client.request('getRoot');
        const addonsActor = rootInfo.addonsActor;
        if (!addonsActor) {
            throw new Error('Firefox does not provide an addons actor');
        }

        // 4. Install helper extension FIRST (so XPCOM observers are active before the extension fetches config)
        helperTmpDir = await installHelperExtension(client, addonsActor, server.port);

        // 5. Wait for helper's ready event
        await server.waitForEvent((e) => e.type === 'ready', 10000);

        // 6. Install the extension under test
        const installResult = await client.request({
            to: addonsActor,
            type: 'installTemporaryAddon',
            addonPath: extensionPath,
        });

        // 7. Get the extension's background console actor
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
                addon: installResult.addon,
                client,
                backgroundConsoleActor,
                evalResults,
            },
        };
    } catch (err) {
        client.disconnect();
        await server.stop();
        // Close the Playwright context so the Firefox process terminates
        // rather than running as an orphan until the worker times out.
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
    return Promise.race([promise.catch(() => null), new Promise((resolve) => setTimeout(resolve, ms))]);
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

module.exports = {
    ensureFirefoxPatched,
    FirefoxBackgroundPage,
    createFirefoxContext,
    cleanupFirefoxContext,
};
