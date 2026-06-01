/**
 * Translates the XPCOM helper extension's network events (delivered via the
 * FirefoxWebServer) into Playwright-style network events, so the shared test
 * helpers can listen with `page.on('requestfinished'|'requestfailed', ...)` on
 * both Chrome and Firefox without any Firefox-specific branch.
 *
 * The XPCOM observer is global (it sees every request in the Firefox instance,
 * both content-page and extension-background), so a single bridge per context is
 * shared by the wrapped `page` and `context`/`backgroundNetworkContext` — which
 * matches the previous behaviour where `logPageRequestsFirefox` read one global
 * stream regardless of the page/context it was given.
 */

const { EventEmitter } = require('events');

// Map nsIContentPolicy external type constants to resource type strings.
// Values from https://searchfox.org/mozilla-central/source/dom/base/nsIContentPolicy.idl;
// strings match Firefox's webRequest.ResourceType naming.
const CONTENT_POLICY_TYPE_MAP = {
    1: 'other',
    2: 'script',
    3: 'image',
    4: 'stylesheet',
    5: 'object',
    6: 'main_frame',
    7: 'sub_frame',
    10: 'ping',
    11: 'xmlhttprequest',
    13: 'xml_dtd',
    14: 'font',
    15: 'media',
    16: 'websocket',
    17: 'csp_report',
    18: 'xslt',
    19: 'beacon',
    20: 'fetch',
    21: 'imageset',
    22: 'web_manifest',
};

// Translate Firefox webRequest names to Playwright `request.resourceType()`
// strings, so the Chrome and Firefox paths report the same type for a given
// request. Names absent here pass through unchanged.
// Playwright's enum: document, stylesheet, image, media, font, script,
// texttrack, xhr, fetch, eventsource, websocket, manifest, other.
const FIREFOX_TO_PLAYWRIGHT_TYPE = {
    main_frame: 'document',
    sub_frame: 'document',
    xmlhttprequest: 'xhr',
    web_manifest: 'manifest',
    imageset: 'image',
    object: 'other',
    ping: 'other',
    xml_dtd: 'other',
    csp_report: 'other',
    xslt: 'other',
    beacon: 'other',
};

// NS_ERROR_ABORT = 0x80004004 (2147500036 as unsigned)
const NS_ERROR_ABORT = 0x80004004;

// errorText values chosen so the shared requests.js helper maps them the same
// way it maps Chrome failures: it treats `net::ERR_ABORTED` /
// `net::ERR_BLOCKED_BY_CLIENT` as "blocked" and everything else as "failed".
const BLOCKED_ERROR_TEXT = 'net::ERR_ABORTED';

/**
 * Build a minimal object that mimics the parts of Playwright's `Request` that
 * the test helpers use: `url()`, `method()`, `resourceType()`, `redirectedTo()`
 * and `failure()`.
 */
function makeRequestLike({ url, method, firefoxType, redirected, failureText }) {
    const type = FIREFOX_TO_PLAYWRIGHT_TYPE[firefoxType] || firefoxType || 'other';
    return {
        url: () => url,
        method: () => method,
        resourceType: () => type,
        redirectedTo: () => (redirected ? {} : null),
        redirectedFrom: () => null,
        failure: () => (failureText ? { errorText: failureText } : null),
        response: () => Promise.resolve(null),
    };
}

class NetworkEventBridge {
    /**
     * @param {import('./web-server.js').FirefoxWebServer} firefoxWebServer
     */
    constructor(firefoxWebServer) {
        this._server = firefoxWebServer;
        this._emitter = new EventEmitter();
        // Allow many concurrent logPageRequests() listeners without warnings.
        this._emitter.setMaxListeners(0);

        // Track pending requests by channelId, and resolved channelIds so a
        // `stop` event doesn't double-emit after a `response` event.
        this._pending = new Map();
        this._resolved = new Set();

        this._processEvent = (event) => this._handleEvent(event);
        this._server.on('event', this._processEvent);
    }

    on(event, listener) {
        this._emitter.on(event, listener);
    }

    off(event, listener) {
        this._emitter.off(event, listener);
    }

    once(event, listener) {
        this._emitter.once(event, listener);
    }

    dispose() {
        this._server.off('event', this._processEvent);
        this._emitter.removeAllListeners();
        this._pending.clear();
        this._resolved.clear();
    }

    _emitFinished(request, { redirected } = {}) {
        this._emitter.emit(
            'requestfinished',
            makeRequestLike({
                url: request.url,
                method: request.method,
                firefoxType: CONTENT_POLICY_TYPE_MAP[request.contentPolicyType],
                redirected,
            }),
        );
    }

    _emitFailed(request, failureText) {
        this._emitter.emit(
            'requestfailed',
            makeRequestLike({
                url: request.url,
                method: request.method,
                firefoxType: CONTENT_POLICY_TYPE_MAP[request.contentPolicyType],
                failureText,
            }),
        );
    }

    _handleEvent(event) {
        if (event.source !== 'xpcom') return;
        const channelId = event.channelId;
        if (!channelId) return;

        if (event.type === 'request') {
            this._pending.set(channelId, {
                url: event.url,
                method: event.method,
                contentPolicyType: event.contentPolicyType,
            });
            return;
        }

        if (event.type === 'response' || event.type === 'cached-response') {
            const request = this._pending.get(channelId);
            if (!request) return;
            this._pending.delete(channelId);
            this._resolved.add(channelId);
            this._emitFinished(request, { redirected: !!event.redirectUrl });
            return;
        }

        if (event.type === 'stop') {
            // Skip if already resolved by a response event.
            if (this._resolved.has(channelId)) {
                this._resolved.delete(channelId);
                return;
            }
            const request = this._pending.get(channelId);
            if (!request) return;
            this._pending.delete(channelId);

            if (event.requestStatus === NS_ERROR_ABORT) {
                this._emitFailed(request, BLOCKED_ERROR_TEXT);
            } else if (event.requestStatus !== 0) {
                this._emitFailed(request, `firefox:status=0x${event.requestStatus.toString(16)}`);
            } else {
                // status 0 (NS_OK) with no response event — treat as allowed.
                this._emitFinished(request, { redirected: false });
            }
        }
    }
}

module.exports = { NetworkEventBridge };
