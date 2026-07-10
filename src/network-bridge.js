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
 *
 * Extension background requests are redirected to the harness server, so their real
 * outcome is only known there: the server emits a `proxy-complete` event (source
 * 'server') that is the terminal event for such requests. That event can race ahead of
 * the request event (the request event is held by the helper's flush while
 * proxy-complete is emitted in-process), so an early completion is buffered until the
 * request event arrives.
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

// NS_BINDING_REDIRECTED = 0x804b0003 — the status the original channel's stop carries
// after it is replaced by redirectTo(). For a proxied request this is NOT a failure;
// the terminal event is the server's proxy-complete.
const NS_BINDING_REDIRECTED = 0x804b0003;

// errorText values chosen so the shared requests.js helper maps them the same
// way it maps Chrome failures: it treats `net::ERR_ABORTED` /
// `net::ERR_BLOCKED_BY_CLIENT` as "blocked" and everything else as "failed".
const BLOCKED_ERROR_TEXT = 'net::ERR_ABORTED';

/**
 * Build a minimal object that mimics the parts of Playwright's `Request` that
 * the test helpers use: `url()`, `method()`, `resourceType()`, `redirectedTo()`
 * and `failure()`.
 */
function makeRequestLike({ url, method, firefoxType, redirected, redirectUrl, failureText }) {
    const type = FIREFOX_TO_PLAYWRIGHT_TYPE[firefoxType] || firefoxType || 'other';
    return {
        url: () => url,
        method: () => method,
        resourceType: () => type,
        // When redirected, return a request-like for the redirect target so callers can
        // read redirectedTo().url() (the previous bare {} threw on any method call).
        redirectedTo: () => (redirected ? makeRequestLike({ url: redirectUrl || url, method, firefoxType }) : null),
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
        // `stop` event doesn't double-emit after a terminal event.
        this._pending = new Map();
        this._resolved = new Set();
        // proxy-complete events that arrived before their request event (see below).
        this._earlyProxyCompletions = new Map();

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
        this._earlyProxyCompletions.clear();
    }

    _absolute(url, base) {
        try {
            return new URL(url, base).href;
        } catch {
            return url;
        }
    }

    _emitFinished(request, { redirected, redirectUrl } = {}) {
        this._emitter.emit(
            'requestfinished',
            makeRequestLike({
                url: request.url,
                method: request.method,
                firefoxType: CONTENT_POLICY_TYPE_MAP[request.contentPolicyType],
                redirected,
                redirectUrl,
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

    // Emit the terminal event for a proxied request from its server-side proxy-complete.
    _completeProxied(channelId, request, event) {
        this._pending.delete(channelId);
        // Guard against a late redirect-cancellation stop double-emitting — unless it was
        // already seen, in which case no further stop is expected.
        if (!request.sawRedirectStop) {
            this._resolved.add(channelId);
        }
        if (event.failure) {
            this._emitFailed(request, event.failure);
        } else {
            this._emitFinished(request, { redirected: !!event.redirectUrl, redirectUrl: event.redirectUrl });
        }
    }

    _handleEvent(event) {
        // Events come from the XPCOM helper (source 'xpcom') and this server's own
        // proxy-complete emission (source 'server').
        if (event.source !== 'xpcom' && event.source !== 'server') return;
        const channelId = event.channelId;
        if (!channelId) return;

        if (event.type === 'request') {
            const request = {
                url: event.url,
                method: event.method,
                contentPolicyType: event.contentPolicyType,
                proxied: !!event.proxied,
                sawRedirectStop: false,
            };
            this._pending.set(channelId, request);
            // A proxied request's terminal proxy-complete can arrive before this request
            // event; drain a buffered one now.
            const early = this._earlyProxyCompletions.get(channelId);
            if (early) {
                this._earlyProxyCompletions.delete(channelId);
                this._completeProxied(channelId, request, early);
            }
            return;
        }

        if (event.type === 'proxy-complete') {
            if (this._resolved.has(channelId)) {
                this._resolved.delete(channelId);
                return;
            }
            const request = this._pending.get(channelId);
            if (!request) {
                // Request event hasn't arrived yet — buffer until it does.
                this._earlyProxyCompletions.set(channelId, event);
                return;
            }
            this._completeProxied(channelId, request, event);
            return;
        }

        if (event.type === 'response' || event.type === 'cached-response') {
            const request = this._pending.get(channelId);
            if (!request) return;
            // Proxied requests are resolved by proxy-complete, not response events.
            if (request.proxied) return;
            this._pending.delete(channelId);
            this._resolved.add(channelId);
            const redirectUrl = event.redirectUrl ? this._absolute(event.redirectUrl, event.url) : undefined;
            this._emitFinished(request, { redirected: !!event.redirectUrl, redirectUrl });
            return;
        }

        if (event.type === 'stop') {
            // Skip if already resolved by a response / proxy-complete event.
            if (this._resolved.has(channelId)) {
                this._resolved.delete(channelId);
                return;
            }
            const request = this._pending.get(channelId);
            if (!request) return;

            if (request.proxied) {
                // The original channel's redirect-cancellation stop (status 0 or
                // NS_BINDING_REDIRECTED) is NOT terminal — proxy-complete is. Any other
                // non-zero status means the proxy hop itself failed; report and stop.
                if (event.requestStatus === 0 || event.requestStatus === NS_BINDING_REDIRECTED) {
                    request.sawRedirectStop = true;
                    return;
                }
                this._pending.delete(channelId);
                this._resolved.add(channelId);
                this._emitFailed(request, `firefox:status=0x${event.requestStatus.toString(16)}`);
                return;
            }

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
