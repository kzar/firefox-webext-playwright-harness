const fs = require('fs/promises');
const fsSync = require('fs');
const os = require('os');
const path = require('path');
const JSZip = require('jszip');
const { firefox } = require('@playwright/test');
const { FirefoxRDPClient } = require('./web-ext-rdp.js');
const { acquireRdpPort } = require('./rdp-port.js');
const { FirefoxWebServer } = require('./web-server.js');

function ensureTempPath(dirOrFilePath) {
    if (path.relative(os.tmpdir(), dirOrFilePath).startsWith('..')) {
        throw new Error(`ensureTempPath check failed! Path: "${path.resolve(dirOrFilePath)}"`);
    }
}

function rmTempDir(dirPath) {
    ensureTempPath(dirPath);
    // Retry briefly: the OS can still be releasing file locks just after the
    // browser process exits.
    return fs.rm(dirPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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

/**
 * Remove a tracked temp dir. On failure, warn and keep it in _tempDirs so the
 * process-exit hook gets another go at it.
 */
async function removeTempDir(dirPath) {
    try {
        await rmTempDir(dirPath);
        _tempDirs.delete(dirPath);
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.warn(`Failed to remove temp dir ${dirPath}: ${message}`);
    }
}

const helperExtensionPath = path.join(__dirname, 'xpcom-extension');

const CFG_MARKER = '// --- Firefox Playwright Harness ---';

/**
 * Replace exactly one occurrence of `needle` in `content`, throwing a clear
 * "incompatible Firefox build" error when it is missing or ambiguous.
 *
 * ensureFirefoxPatched relies on this: a silent String.replace no-op (e.g. because a
 * future Playwright Firefox reformatted the patched line) would otherwise rewrite an
 * unpatched omni.ja, still write the cfg marker, and permanently mark the install as
 * patched — surfacing only as an opaque helper-init timeout much later.
 */
function replaceExactlyOnce(content, needle, replacement, fileLabel) {
    const first = content.indexOf(needle);
    if (first === -1) {
        throw new Error(
            `Firefox patch needle not found in ${fileLabel}: ${JSON.stringify(needle)}. ` +
                'The harness is incompatible with this Playwright Firefox build.',
        );
    }
    if (content.indexOf(needle, first + needle.length) !== -1) {
        throw new Error(
            `Firefox patch needle occurs more than once in ${fileLabel}: ${JSON.stringify(needle)}. ` +
                'The harness is incompatible with this Playwright Firefox build.',
        );
    }
    return content.slice(0, first) + replacement + content.slice(first + needle.length);
}

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
        // Parallel Playwright workers patching the same install concurrently could
        // corrupt omni.ja — the patch must be applied once, before workers start.
        if (process.env.TEST_WORKER_INDEX !== undefined) {
            throw new Error(
                "Playwright's bundled Firefox has not been patched for the harness. Add " +
                    "globalSetup: 'firefox-webext-playwright-harness/globalSetup' to your Playwright " +
                    'config so the patch is applied once before test workers start.',
            );
        }
        // Patch omni.ja. Compute both replacements up front (asserting each needle
        // matches exactly once) BEFORE mutating the zip, so an incompatible Firefox
        // build fails loudly here rather than silently writing an unpatched omni.ja.
        const omniPath = path.join(firefoxDir, 'omni.ja');
        const zip = await JSZip.loadAsync(await fs.readFile(omniPath));

        const addonSettingsFile = zip.file('modules/addons/AddonSettings.sys.mjs');
        if (!addonSettingsFile) throw new Error('AddonSettings.sys.mjs not found in omni.ja');
        const patchedAddonSettings = replaceExactlyOnce(
            await addonSettingsFile.async('string'),
            'makeConstant("EXPERIMENTS_ENABLED", false)',
            'makeConstant("EXPERIMENTS_ENABLED", true)',
            'omni.ja:modules/addons/AddonSettings.sys.mjs',
        );

        const jugglerChildFile = zip.file('chrome/juggler/content/content/JugglerFrameChild.jsm');
        if (!jugglerChildFile) throw new Error('JugglerFrameChild.jsm not found in omni.ja');
        const patchedJugglerChild = replaceExactlyOnce(
            await jugglerChildFile.async('string'),
            'moz-extension://',
            'moz-extension-DISABLED://',
            'omni.ja:chrome/juggler/content/content/JugglerFrameChild.jsm',
        );

        zip.file('modules/addons/AddonSettings.sys.mjs', patchedAddonSettings);
        zip.file('chrome/juggler/content/content/JugglerFrameChild.jsm', patchedJugglerChild);

        // Write-to-temp + rename so a crash mid-write can't leave a truncated omni.ja
        // (Firefox would be unbootable until reinstalled). The cfg marker below is
        // written only after omni.ja is safely in place, so a needle failure above
        // never leaves an unpatched install marked as patched.
        const omniTmpPath = `${omniPath}.tmp-${process.pid}`;
        await fs.writeFile(omniTmpPath, await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' }));
        await fs.rename(omniTmpPath, omniPath);

        // Patch playwright.cfg: lock marionette.running for runtime experiment support.
        const cfgTmpPath = `${cfgPath}.tmp-${process.pid}`;
        await fs.writeFile(
            cfgTmpPath,
            cfgContent +
                ['', CFG_MARKER, 'lockPref("marionette.running", true);', '// --- End Firefox Playwright Harness ---'].join('\n') +
                '\n',
        );
        await fs.rename(cfgTmpPath, cfgPath);
    }

    _firefoxPatched = true;
}

// Budget for a single RDP request (and the initial connect handshake). RDP matches
// replies to requests by actor with no request IDs, so a request left unanswered can't
// be cancelled in isolation — a late reply would be misattributed to the next request
// on that actor. A request silent for this long therefore means the connection is dead,
// so on timeout we reject with a descriptive error AND tear the connection down (which
// fails every queued request fast via 'disconnect').
const RDP_REQUEST_TIMEOUT_MS = 30000;

function withRdpDeadline(client, promise, timeoutMs, what) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`RDP request timed out after ${timeoutMs}ms: ${what} — closing the RDP connection`));
            client.disconnect();
        }, timeoutMs);
        timer.unref?.();
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (err) => {
                clearTimeout(timer);
                reject(err);
            },
        );
    });
}

/**
 * Send an RDP request bounded by a deadline. `what` names the request in the timeout
 * error. Used for every harness RDP request so a wedged-but-alive Firefox can't hang
 * setup or evaluate() indefinitely (the vendored request() itself has no timeout).
 */
function rdpRequest(client, requestProps, { timeoutMs = RDP_REQUEST_TIMEOUT_MS, what } = {}) {
    const label = what ?? (typeof requestProps === 'string' ? requestProps : requestProps.type);
    return withRdpDeadline(client, client.request(requestProps), timeoutMs, label);
}

/**
 * Resolve a Firefox RDP "grip" (the value shape carried in evaluationResult.result)
 * into a plain JS value.
 *
 * Only two shapes can legitimately occur here: primitives (the evaluate wrapper's
 * completion value is always a JSON string, and exceptionMessage is a string), which
 * arrive as-is; and a longString grip (`{ type: 'longString', initial, length, actor }`,
 * returned whenever a string exceeds the RDP inline limit of ~10KB), which is
 * reassembled by fetching the remainder from its actor via `substring`. Anything else
 * is a protocol surprise and throws an error naming the grip.
 */
async function resolveGrip(client, grip) {
    if (grip === null || typeof grip !== 'object') {
        return grip;
    }
    if (grip.type === 'longString') {
        let full = grip.initial || '';
        while (full.length < grip.length) {
            const response = await rdpRequest(
                client,
                {
                    to: grip.actor,
                    type: 'substring',
                    start: full.length,
                    end: grip.length,
                },
                { what: 'substring (longString reassembly)' },
            );
            const chunk = typeof response.substring === 'string' ? response.substring : '';
            if (!chunk) {
                throw new Error(`longString grip truncated: got ${full.length} of ${grip.length} characters`);
            }
            full += chunk;
        }
        return full;
    }
    throw new Error(
        `Unexpected evaluate result grip (type: ${grip.type || 'none'}, class: ${grip.class || 'none'})` +
            (grip.class === 'Promise' ? " — got a pending Promise grip; does this Firefox support evaluateJSAsync's mapped: { await: true }?" : ''),
    );
}

/**
 * Wait for the `evaluationResult` RDP event carrying `resultID` and resolve with it.
 *
 * Results arrive as unsolicited `evaluationResult` events, which connectExtensionRdp()
 * buffers into the client's `_evalResults` map and re-emits on the client as
 * `evaluationResult:<resultID>`. We resolve the moment that event fires (push) rather
 * than polling, falling back to the buffer for the rare case the event landed before we
 * started waiting.
 */
function waitForEvaluationResult(client, resultID, timeoutMs) {
    return new Promise((resolve, reject) => {
        const evalResults = client._evalResults;
        // The result may already have arrived between sending the request and now.
        if (evalResults.has(resultID)) {
            const buffered = evalResults.get(resultID);
            evalResults.delete(resultID);
            resolve(buffered);
            return;
        }
        // The connection may already be gone (teardown raced the request's ack) —
        // fail fast rather than waiting out the timeout for an event that can't come.
        if (!client._rdpConnection) {
            reject(new Error('RDP connection closed while waiting for evaluation result'));
            return;
        }
        const eventName = `evaluationResult:${resultID}`;
        const cleanup = () => {
            clearTimeout(timer);
            client.off(eventName, onResult);
            client.off('disconnect', onDisconnect);
            evalResults.delete(resultID);
        };
        const onResult = (message) => {
            cleanup();
            resolve(message);
        };
        const onDisconnect = (error) => {
            cleanup();
            reject(new Error(`RDP connection closed while waiting for evaluation result: ${error?.message || error}`));
        };
        const timer = setTimeout(() => {
            cleanup();
            reject(new Error(`Timeout waiting for evaluation result (resultID: ${resultID})`));
        }, timeoutMs);
        timer.unref?.();
        client.once(eventName, onResult);
        client.once('disconnect', onDisconnect);
    });
}

/**
 * Send an evaluateJSAsync request and return its acknowledgement, which carries the
 * resultID the eventual evaluationResult event is keyed by.
 *
 * `mapped: { await: true }` makes the console actor await a Promise completion value
 * server-side, so the evaluationResult event carries the settled value rather than a
 * pending-promise grip. Non-Promise completion values are unaffected by the flag.
 */
async function sendEvaluate(client, consoleActor, text) {
    let request;
    try {
        request = await rdpRequest(
            client,
            { to: consoleActor, type: 'evaluateJSAsync', text, mapped: { await: true } },
            { what: 'evaluateJSAsync' },
        );
    } catch (e) {
        throw new Error(`RDP evaluateJSAsync request failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!request.resultID) {
        throw new Error(`RDP evaluateJSAsync did not return a resultID: ${JSON.stringify(request)}`);
    }
    return request;
}

/**
 * Read an evaluationResult's value as a string, reassembling it from a longString grip
 * when it exceeds the RDP inline limit (~10KB).
 */
async function readResultString(client, result) {
    const value = await resolveGrip(client, result.result);
    if (typeof value !== 'string') {
        throw new Error(`Unexpected result type: ${typeof value}`);
    }
    return value;
}

// Budget for one whole evaluate round trip: RDP delivery of the ack and result event,
// including the server-side await of the evaluated promise.
const EVAL_RESULT_TIMEOUT_MS = 30000;

/**
 * Rebuild an Error thrown/rejected in the background context from the details the
 * evaluate wrapper serialised ({ message, name, stack }), preserving the remote error
 * name and appending the remote stack for diagnosis.
 */
function buildRemoteError(details) {
    const error = new Error(`Evaluation error: ${details.message}`);
    if (details.name && details.name !== 'Error') {
        error.name = details.name;
    }
    if (details.stack) {
        error.stack += `\nCaused by (remote): ${details.stack}`;
    }
    return error;
}

/**
 * Evaluate JavaScript code in the Firefox extension's background page via RDP and
 * return its result.
 *
 * The code is wrapped in an async IIFE whose completion value is a Promise, which the
 * console actor awaits server-side (mapped.await on the evaluateJSAsync request), so a
 * single pushed evaluationResult event carries the settled value — one round trip per
 * evaluate, however long the promise takes to settle. The wrapper always resolves,
 * serialising errors ({ message, name, stack }) into the JSON envelope, because a
 * rejected promise reaching the actor's awaited path is reported as just
 * { topLevelAwaitRejected: true } with no rejection reason. Large results (longString
 * grips) are reassembled by resolveGrip, so this works regardless of result size.
 */
async function evaluateInFirefoxBackground(client, consoleActor, code) {
    if (!consoleActor) {
        throw new Error('No background console actor available');
    }

    // Check if the client is still connected (web-ext uses _rdpConnection)
    if (!client._rdpConnection) {
        throw new Error('RDP client is not connected');
    }

    // The evaluated code is emitted on its own lines inside the parens so a trailing
    // line comment in a string expression can't comment out the closing tokens.
    const wrappedCode = `
        (async function () {
            try {
                var __result__ = await (function () { return (
${code}
); })();
                return JSON.stringify({ __ok__: true, __value__: __result__ });
            } catch (error) {
                var details = { message: '', name: 'Error', stack: '' };
                try {
                    if (error && typeof error.message === 'string') {
                        details.message = error.message;
                        details.name = (error.name && String(error.name)) || 'Error';
                        details.stack = (error.stack && String(error.stack)) || '';
                    } else if (error && typeof error === 'object') {
                        details.message = JSON.stringify(error);
                    } else {
                        details.message = String(error);
                    }
                } catch (serializationError) {
                    details.message = String(error);
                }
                return JSON.stringify({ __ok__: false, __error__: details });
            }
        })()
    `;

    const evalRequest = await sendEvaluate(client, consoleActor, wrappedCode);
    const result = await waitForEvaluationResult(client, evalRequest.resultID, EVAL_RESULT_TIMEOUT_MS);
    if (result.hasException) {
        // exceptionMessage can itself arrive as a longString grip.
        const exceptionMessage = await resolveGrip(client, result.exceptionMessage);
        throw new Error(`Evaluation error: ${exceptionMessage}`);
    }
    if (result.topLevelAwaitRejected) {
        // Unreachable unless the wrapper's own catch block throws or the wrapper is
        // bypassed — kept for a clear error over a cryptic missing-result failure.
        throw new Error('Evaluation error: promise rejected');
    }
    const parsed = JSON.parse(await readResultString(client, result));
    if (!parsed.__ok__) {
        throw buildRemoteError(parsed.__error__);
    }
    return parsed.__value__;
}

/**
 * Serialise one evaluate() argument into JS source. JSON covers everything Playwright's
 * evaluate contract supports over this transport; `undefined` becomes the literal
 * `undefined` (JSON.stringify would return the *value* undefined, corrupting the
 * generated argument list), and unserialisable values fail loudly rather than
 * generating a SyntaxError or silently dropping the argument. Inherent JSON
 * round-trip lossiness remains: NaN/Infinity become null, -0 becomes 0, and Dates
 * become strings.
 */
function serializeEvalArg(arg, index) {
    if (arg === undefined) {
        return 'undefined';
    }
    const json = JSON.stringify(arg);
    if (json === undefined) {
        throw new Error(`Unsupported evaluate() argument at index ${index}: ${typeof arg} is not serializable`);
    }
    return json;
}

/**
 * Wrapper class providing background page functionality for Firefox via RDP.
 * Provides an API similar to Playwright's Page/Worker for evaluate() calls.
 *
 * evaluate() calls are serialised via a lock so concurrent callers' code runs one at
 * a time in the background context, keeping side-effect ordering predictable.
 * (Results themselves are matched by resultID, so this is a semantic choice, not a
 * transport requirement.)
 */
class FirefoxBackgroundPage {
    constructor(rdpClient, consoleActor) {
        this._client = rdpClient;
        this._consoleActor = consoleActor;
        this._evalLock = Promise.resolve(); // Lock for serializing evaluate calls
    }

    async evaluate(pageFunction, ...args) {
        if (!this._consoleActor) {
            throw new Error('Firefox background page not available');
        }
        let code;
        if (typeof pageFunction === 'function') {
            const fnStr = pageFunction.toString();
            const serializedArgs = args.map(serializeEvalArg).join(', ');
            code = `(${fnStr})(${serializedArgs})`;
        } else {
            code = String(pageFunction);
        }
        // Serialize evaluate calls (see the class doc comment). A rejected evaluation
        // must still release the lock for the next caller, hence the swallowed
        // continuation stored on _evalLock.
        const run = this._evalLock.then(() => evaluateInFirefoxBackground(this._client, this._consoleActor, code));
        this._evalLock = run.then(
            () => {},
            () => {},
        );
        return run;
    }

    // Playwright signature: (pageFunction, arg, options). backgroundWait.js
    // (forFunction/forSetting) calls this Playwright-style.
    async waitForFunction(pageFunction, arg, options) {
        const { timeout = 30000, polling = 100 } = options || {};
        // Playwright semantics: timeout 0 disables the timeout.
        const deadline = timeout === 0 ? Infinity : Date.now() + timeout;
        // Only forward the argument when the caller actually supplied one.
        const evalArgs = arguments.length >= 2 ? [arg] : [];
        const startTime = Date.now();
        let lastError = null;
        while (true) {
            try {
                const result = await this.evaluate(pageFunction, ...evalArgs);
                if (result) return result;
                lastError = null;
            } catch (e) {
                // Transient evaluation failures are expected while polling, but a dead
                // connection cannot recover — fail fast instead of burning the timeout.
                lastError = e;
                const message = e instanceof Error ? e.message : String(e);
                if (
                    message.includes('RDP client is not connected') ||
                    message.includes('RDP connection closed') ||
                    message.includes('RDP request timed out')
                ) {
                    throw e;
                }
            }
            if (Date.now() > deadline) {
                const source = String(pageFunction).replace(/\s+/g, ' ').slice(0, 200);
                const lastErrorSuffix = lastError ? ` (last error: ${lastError instanceof Error ? lastError.message : String(lastError)})` : '';
                throw new Error(`Timed out after ${Date.now() - startTime}ms waiting for function: ${source}${lastErrorSuffix}`);
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
    try {
        await fs.cp(helperExtensionPath, tmpDir, { recursive: true });
        await fs.writeFile(path.join(tmpDir, 'config.json'), JSON.stringify({ port: serverPort }));

        await rdpRequest(
            client,
            {
                to: addonsActor,
                type: 'installTemporaryAddon',
                addonPath: tmpDir,
            },
            { what: 'installTemporaryAddon (helper extension)' },
        );
    } catch (err) {
        await removeTempDir(tmpDir);
        throw err;
    }

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
    const client = new FirefoxRDPClient();
    // Socket errors tear the client down (rejecting in-flight requests and firing
    // 'disconnect'); surface them for diagnosis rather than swallowing silently.
    client.on('error', (err) => console.warn(`RDP client error: ${err?.message || err}`));
    // Buffer evaluation results on the client itself (keyed by resultID) so
    // waitForEvaluationResult can read them without the map being threaded through every
    // layer; clear it when the connection drops.
    const evalResults = new Map();
    client._evalResults = evalResults;
    client.on('disconnect', () => evalResults.clear());
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
            client.emit('target-available', msg.target);
        }
    });
    await withRdpDeadline(client, client.connect(rdpPort), RDP_REQUEST_TIMEOUT_MS, 'connect (root hello)');

    try {
        const rootInfo = await rdpRequest(client, 'getRoot', { what: 'getRoot' });
        const addonsActor = rootInfo.addonsActor;
        if (!addonsActor) {
            throw new Error('Firefox does not provide an addons actor');
        }
        return { client, workerTargets, addonsActor };
    } catch (err) {
        client.disconnect();
        throw err;
    }
}

/**
 * Build a predicate that recognises the extension's background page target, plus a
 * human `description` for error messages.
 *
 * Firefox only synthesises the `_generated_background_page` URL for `background.scripts`;
 * an extension declaring `background.page` announces its authored page URL instead. We
 * read the manifest to cover both. The moz-extension:// UUID host is unknown ahead of
 * time, so a declared page is matched by URL pathname suffix plus a console actor.
 */
async function buildBackgroundTargetMatcher(extensionPath) {
    const generated = {
        description: "the generated background page ('_generated_background_page')",
        isBackground: (t) => Boolean(t && t.url && t.url.includes('_generated_background_page') && t.consoleActor),
    };
    let manifest;
    try {
        let raw = await fs.readFile(path.join(extensionPath, 'manifest.json'), 'utf8');
        // Strip a leading BOM; Firefox tolerates it but JSON.parse does not.
        if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
        manifest = JSON.parse(raw);
    } catch {
        // The install already validated the manifest; if we can't read/parse it here
        // (e.g. it uses comments) fall back to the generated-page matcher.
        return generated;
    }
    const page = manifest.background && typeof manifest.background.page === 'string' ? manifest.background.page : null;
    if (!page) {
        return generated;
    }
    const normalized = page.replace(/^\.?\//, '');
    const pathnameOf = (url) => {
        try {
            return new URL(url).pathname;
        } catch {
            return url;
        }
    };
    return {
        description: `the manifest background.page ('${normalized}')`,
        isBackground: (t) => Boolean(t && t.url && t.consoleActor) && pathnameOf(t.url).endsWith('/' + normalized),
    };
}

/**
 * Wait for the extension's background page target to be announced by the watcher
 * (a 'target-available-form' event, re-emitted by connectExtensionRdp as
 * 'target-available' and buffered in workerTargets). Attach BEFORE sending the
 * watchTargets requests so the announcement can't be missed.
 */
function waitForBackgroundTarget(client, workerTargets, timeoutMs, { isBackground, description }) {
    const buffered = workerTargets.find(isBackground);
    if (buffered) return Promise.resolve(buffered);

    return new Promise((resolve, reject) => {
        if (!client._rdpConnection) {
            reject(new Error('RDP connection closed while waiting for the background page target'));
            return;
        }
        const cleanup = () => {
            clearTimeout(timer);
            client.off('target-available', onTarget);
            client.off('disconnect', onDisconnect);
        };
        const onTarget = (target) => {
            if (!isBackground(target)) return;
            cleanup();
            resolve(target);
        };
        const onDisconnect = (error) => {
            cleanup();
            reject(new Error(`RDP connection closed while waiting for the background page target: ${error?.message || error}`));
        };
        const timer = setTimeout(() => {
            cleanup();
            reject(new Error(`Timed out waiting for the extension's background page target (waited for ${description})`));
        }, timeoutMs);
        timer.unref?.();
        client.on('target-available', onTarget);
        client.once('disconnect', onDisconnect);
    });
}

/**
 * Install the extension under test as a temporary add-on and find the console actor
 * for its background page, so that code can be evaluated in the background context.
 * @param {object} rdp - The result of connectExtensionRdp().
 * @param {string} extensionPath - Absolute path to the built, unpacked extension.
 */
async function installExtensionAndFindBackground(rdp, extensionPath) {
    const { client, workerTargets, addonsActor } = rdp;

    // Firefox reports the installed add-on's id in the response, so the harness doesn't
    // need it configured; this also works for extensions without an explicit gecko id.
    const installResponse = await rdpRequest(
        client,
        {
            to: addonsActor,
            type: 'installTemporaryAddon',
            addonPath: extensionPath,
        },
        { what: 'installTemporaryAddon (extension under test)' },
    );
    const addonId = installResponse?.addon?.id;
    if (!addonId) {
        throw new Error(`installTemporaryAddon did not return an add-on id (response: ${JSON.stringify(installResponse)})`);
    }

    // The installTemporaryAddon ack doesn't guarantee the addon is listed yet, so retry
    // briefly until it appears (we need its actor for getWatcher).
    let ourAddon = null;
    const maxAddonRetries = 40;
    for (let attempt = 0; attempt < maxAddonRetries; attempt++) {
        const addonsResponse = await rdpRequest(client, 'listAddons', { what: 'listAddons' });
        ourAddon = addonsResponse.addons.find((a) => a.id === addonId);
        if (ourAddon) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!ourAddon) {
        throw new Error(`Could not find addon ${addonId} after ${maxAddonRetries} attempts`);
    }

    const watcherResult = await rdpRequest(client, { to: ourAddon.actor, type: 'getWatcher' }, { what: 'getWatcher' });

    // Attach the waiter before watchTargets so the target announcement can't race it.
    const matcher = await buildBackgroundTargetMatcher(extensionPath);
    const backgroundTargetPromise = waitForBackgroundTarget(client, workerTargets, 10000, matcher);
    backgroundTargetPromise.catch(() => {}); // rejection is handled at the await below

    await rdpRequest(client, { to: watcherResult.actor, type: 'watchTargets', targetType: 'frame' }, { what: 'watchTargets (frame)' });
    await rdpRequest(client, { to: watcherResult.actor, type: 'watchTargets', targetType: 'worker' }, { what: 'watchTargets (worker)' });

    let backgroundTarget;
    try {
        backgroundTarget = await backgroundTargetPromise;
    } catch (err) {
        throw new Error(`Could not find background console actor for ${addonId}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const backgroundConsoleActor = backgroundTarget.consoleActor;

    await rdpRequest(
        client,
        {
            to: backgroundConsoleActor,
            type: 'startListeners',
            listeners: ['evaluationResult'],
        },
        { what: 'startListeners' },
    );

    return { backgroundConsoleActor };
}

/**
 * @param {number} rdpPort - Port for Firefox's remote debugging server.
 * @param {string} extensionPath - Absolute path to the built, unpacked extension.
 * @param {object} [options]
 * @param {function} [options.routeHandler] - Playwright-style handler for the extension's
 *   redirected background requests.
 * @param {Array<[string, string]>} [options.rewriteStaticRules] - Ordered [from, to] rewrites
 *   applied to a redirected request's reconstructed URL.
 * @param {object} [options.playwrightOptions] - Resolved standard Playwright `use` options
 *   (headless, launchOptions, viewport, ...) forwarded from the `context` fixture.
 */
async function createFirefoxContext(rdpPort, extensionPath, options = {}) {
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

    let userDataDir;
    let context;
    let client;
    let helperTmpDir;
    try {
        // 2. Launch Firefox (patched for experiment_apis support)
        await ensureFirefoxPatched();
        userDataDir = await fs.mkdtemp(`${os.tmpdir()}/firefox-test-`);
        _tempDirs.add(userDataDir);
        context = await firefox.launchPersistentContext(userDataDir, buildFirefoxLaunchOptions(rdpPort, playwrightOptions));

        // 3. Connect via RDP
        const rdp = await connectExtensionRdp(rdpPort);
        client = rdp.client;
        const { addonsActor } = rdp;

        // 4. Install helper extension FIRST (so XPCOM observers are active before the extension fetches config)
        helperTmpDir = await installHelperExtension(client, addonsActor, server.port);

        // 5. Wait for helper's ready event
        const ready = await server.waitForEvent((e) => e.type === 'ready', 10000);
        if (ready.errors && ready.errors.length > 0) {
            throw new Error(`Firefox harness helper extension failed to initialise: ${ready.errors.join('; ')}`);
        }

        // 6 + 7. Install the extension under test and find its background console actor
        const { backgroundConsoleActor } = await installExtensionAndFindBackground(rdp, extensionPath);

        // Store for cleanup. Cast context to allow stashing private fields.
        const ctx = /** @type {any} */ (context);
        ctx._firefoxUserDataDir = userDataDir;
        ctx._firefoxHelperTmpDir = helperTmpDir;
        ctx._rdpClient = client;
        ctx._firefoxBackgroundConsoleActor = backgroundConsoleActor;
        ctx._firefoxWebServer = server;

        return { context };
    } catch (err) {
        // Close Firefox before stopping the server (teardownFirefoxResources encodes the
        // correct order); an unbounded stop here would mask `err` behind the test timeout.
        await teardownFirefoxResources({ client, context, server, tempDirs: [helperTmpDir, userDataDir] });
        throw err;
    }
}

// Resolve `promise` or null after `ms` so a wedged Firefox / RDP / fs op can't
// burn the whole 60s teardown budget on one stuck await.
function withTimeout(promise, ms) {
    let timer;
    const timeout = new Promise((resolve) => {
        timer = setTimeout(resolve, ms);
    });
    return Promise.race([promise.catch(() => null), timeout]).finally(() => clearTimeout(timer));
}

/**
 * Tear down harness resources in the one correct order, so every call site shares it:
 * 1. disconnect the RDP client (synchronous; rejects in-flight work, and its 'disconnect'
 *    listener clears the eval-result buffer)
 * 2. close the browser context (bounded) — BEFORE stopping the server, because the browser
 *    can hold in-flight proxied requests open and server.close() waits on active connections
 * 3. stop the web server (bounded)
 * 4. remove temp dirs
 * Every field is optional so the standalone path (no server) and partial-failure paths can
 * reuse it.
 */
async function teardownFirefoxResources({ client = null, context = null, server = null, tempDirs = [] }) {
    if (client) {
        try {
            client.disconnect();
        } catch {
            // Ignore disconnect errors
        }
    }
    if (context) {
        await withTimeout(context.close(), 10000);
    }
    if (server) {
        await withTimeout(server.stop(), 5000);
    }
    for (const dir of tempDirs) {
        if (dir) await removeTempDir(dir);
    }
}

/**
 * Clean up Firefox context resources.
 */
async function cleanupFirefoxContext(context) {
    await teardownFirefoxResources({
        client: context._rdpClient,
        context,
        server: context._firefoxWebServer,
        tempDirs: [context._firefoxUserDataDir, context._firefoxHelperTmpDir],
    });
    context._rdpClient = null;
    context._firefoxWebServer = null;
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
 * @param {boolean} [options.headless] - Defaults to Playwright's default (headless).
 * @param {object} [options.firefoxUserPrefs] - Extra Firefox preferences, e.g.
 *   `{ 'extensions.dnr.feedback': true }`. The harness's required preferences are
 *   layered on top and always win.
 * @param {string[]} [options.args] - Extra Firefox command line arguments.
 * @returns {Promise<{ background: FirefoxBackgroundPage, close: () => Promise<void> }>}
 */
async function launchExtensionBackground({ extensionPath, headless, firefoxUserPrefs, args }) {
    const { port: rdpPort, release: releaseRdpPort } = await acquireRdpPort();

    const userDataDir = await fs.mkdtemp(`${os.tmpdir()}/firefox-ext-background-`);
    _tempDirs.add(userDataDir);

    let context = null;
    let client = null;
    try {
        context = await firefox.launchPersistentContext(
            userDataDir,
            buildFirefoxLaunchOptions(rdpPort, { headless, launchOptions: { firefoxUserPrefs, args } }),
        );

        const rdp = await connectExtensionRdp(rdpPort);
        client = rdp.client;

        const { backgroundConsoleActor } = await installExtensionAndFindBackground(rdp, extensionPath);
        const background = new FirefoxBackgroundPage(client, backgroundConsoleActor);

        let closed = false;
        const close = async () => {
            if (closed) return;
            closed = true;
            await teardownFirefoxResources({ client, context, tempDirs: [userDataDir] });
            await releaseRdpPort();
        };

        return { background, close };
    } catch (err) {
        await teardownFirefoxResources({ client, context, tempDirs: [userDataDir] });
        await releaseRdpPort();
        throw err;
    }
}

module.exports = {
    ensureFirefoxPatched,
    FirefoxBackgroundPage,
    createFirefoxContext,
    cleanupFirefoxContext,
    launchExtensionBackground,
    buildFirefoxLaunchOptions,
    replaceExactlyOnce,
    rdpRequest,
};
