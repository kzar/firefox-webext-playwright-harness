/**
 * Local HTTP server for Firefox integration tests.
 *
 * Two roles:
 * 1. Receives request events POSTed by the XPCOM helper extension.
 * 2. Serves the extension's redirected background requests (`/proxy/...`) by
 *    running the consumer's route handlers, falling back to the real origin —
 *    unifying Firefox with Chrome's `context.route` interception.
 */

const http = require('http');
const fs = require('fs/promises');
const { EventEmitter } = require('events');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

// Minimal extension→MIME map for route.fulfill({ path }), mirroring how Playwright
// guesses a Content-Type from the file extension.
const EXTENSION_MIME_TYPES = {
    json: 'application/json',
    html: 'text/html',
    htm: 'text/html',
    js: 'text/javascript',
    mjs: 'text/javascript',
    css: 'text/css',
    txt: 'text/plain',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    ico: 'image/x-icon',
    webp: 'image/webp',
    woff: 'font/woff',
    woff2: 'font/woff2',
    wasm: 'application/wasm',
    xml: 'application/xml',
    pdf: 'application/pdf',
    zip: 'application/zip',
};

function guessContentType(filePath) {
    const ext = filePath.split('.').pop().toLowerCase();
    return EXTENSION_MIME_TYPES[ext] || 'application/octet-stream';
}

// Playwright route.abort() error codes → the errorText the bridge reports (which the
// shared requests helper then classifies the same way as the Chrome path).
const ABORT_ERROR_TEXT = {
    aborted: 'net::ERR_ABORTED',
    accessdenied: 'net::ERR_ACCESS_DENIED',
    addressunreachable: 'net::ERR_ADDRESS_UNREACHABLE',
    blockedbyclient: 'net::ERR_BLOCKED_BY_CLIENT',
    blockedbyresponse: 'net::ERR_BLOCKED_BY_RESPONSE',
    connectionaborted: 'net::ERR_CONNECTION_ABORTED',
    connectionclosed: 'net::ERR_CONNECTION_CLOSED',
    connectionfailed: 'net::ERR_CONNECTION_FAILED',
    connectionrefused: 'net::ERR_CONNECTION_REFUSED',
    connectionreset: 'net::ERR_CONNECTION_RESET',
    internetdisconnected: 'net::ERR_INTERNET_DISCONNECTED',
    namenotresolved: 'net::ERR_NAME_NOT_RESOLVED',
    timedout: 'net::ERR_TIMED_OUT',
    failed: 'net::ERR_FAILED',
};

// Convert a Playwright-style URL glob (as passed to `context.route`) into a
// RegExp, so the web server can match XPCOM-redirected extension requests
// against routes registered through the harness's wrapped context.
//
// Ported from playwright-core 1.60's resolveGlobBase + globToRegexPattern
// (packages/isomorphic/urlMatch.ts, Apache-2.0) so the same pattern matches
// identically whether Playwright (content-page requests) or this server
// (extension background requests) evaluates it: `**` crosses path segments
// (`/**/` also matches zero segments), `*` stays within a segment, `?` is a
// literal, `{a,b}` expands to alternatives, `\` escapes; non-wildcard-leading
// globs are URL-normalised first (trailing slash, lowercased origin, dot-segment
// resolution). One deliberate difference: `baseURL` is unsupported, since the
// harness never forwards one to the Firefox launch, so Playwright's own
// matching runs without it too.
const GLOB_ESCAPED_CHARS = new Set(['$', '^', '+', '.', '*', '(', ')', '|', '\\', '?', '{', '}', '[', ']']);

// URL-normalise a glob that doesn't start with a wildcard, exactly as
// playwright-core does before compiling it: glob tokens are shielded from the
// URL parser, the URL is round-tripped through `new URL()`, and tokens in the
// case-insensitive origin part are lowercased on restore.
function resolveGlobBase(match) {
    if (match.startsWith('*')) {
        return match;
    }
    const tokenMap = new Map();
    const mapToken = (original, replacement) => {
        if (original.length === 0) {
            return '';
        }
        tokenMap.set(replacement, original);
        return replacement;
    };
    // Escaped `\\?` behaves like a literal `?` for URL parsing purposes.
    match = match.replaceAll(/\\\\\?/g, '?');
    if (
        match.startsWith('about:') ||
        match.startsWith('data:') ||
        match.startsWith('chrome:') ||
        match.startsWith('edge:') ||
        match.startsWith('file:')
    ) {
        return match;
    }
    const relativePath = match
        .split('/')
        .map((token, index) => {
            if (token === '.' || token === '..' || token === '') {
                return token;
            }
            if (index === 0 && token.endsWith(':')) {
                // Protect a wildcarded scheme from URL parsing.
                if (token.indexOf('*') !== -1 || token.indexOf('{') !== -1) {
                    return mapToken(token, 'http:');
                }
                return token;
            }
            const questionIndex = token.indexOf('?');
            if (questionIndex === -1) {
                return mapToken(token, `$_${index}_$`);
            }
            const newPrefix = mapToken(token.substring(0, questionIndex), `$_${index}_$`);
            const newSuffix = mapToken(token.substring(questionIndex), `?$_${index}_$`);
            return newPrefix + newSuffix;
        })
        .join('/');
    let resolved = relativePath;
    let caseInsensitivePart;
    try {
        const url = new URL(relativePath);
        resolved = url.toString();
        caseInsensitivePart = url.origin;
    } catch {
        // Not an absolute URL (and there is no baseURL) — compile it as-is.
    }
    for (const [token, original] of tokenMap) {
        const normalize = caseInsensitivePart?.includes(token);
        resolved = resolved.replace(token, normalize ? original.toLowerCase() : original);
    }
    return resolved;
}
function globToRegExp(glob) {
    glob = resolveGlobBase(glob);
    const tokens = ['^'];
    let inGroup = false;
    for (let i = 0; i < glob.length; ++i) {
        const c = glob[i];
        if (c === '\\' && i + 1 < glob.length) {
            const char = glob[++i];
            tokens.push(GLOB_ESCAPED_CHARS.has(char) ? '\\' + char : char);
            continue;
        }
        if (c === '*') {
            const charBefore = glob[i - 1];
            let starCount = 1;
            while (glob[i + 1] === '*') {
                starCount++;
                i++;
            }
            if (starCount > 1) {
                const charAfter = glob[i + 1];
                if (charAfter === '/') {
                    if (charBefore === '/') {
                        tokens.push('((.+/)|)');
                    } else {
                        tokens.push('(.*/)');
                    }
                    ++i;
                } else {
                    tokens.push('(.*)');
                }
            } else {
                tokens.push('([^/]*)');
            }
            continue;
        }
        switch (c) {
            case '{':
                if (inGroup) {
                    throw new Error(`Invalid glob pattern ${JSON.stringify(glob)}: nested '{' is not supported`);
                }
                inGroup = true;
                tokens.push('(');
                break;
            case '}':
                if (!inGroup) {
                    throw new Error(`Invalid glob pattern ${JSON.stringify(glob)}: unmatched '}'`);
                }
                inGroup = false;
                tokens.push(')');
                break;
            case ',':
                if (inGroup) {
                    tokens.push('|');
                    break;
                }
                tokens.push('\\' + c);
                break;
            default:
                tokens.push(GLOB_ESCAPED_CHARS.has(c) ? '\\' + c : c);
        }
    }
    if (inGroup) {
        throw new Error(`Invalid glob pattern ${JSON.stringify(glob)}: unmatched '{'`);
    }
    tokens.push('$');
    return new RegExp(tokens.join(''));
}

// Collect a request body into a single Buffer (empty for bodyless requests).
function readBody(req) {
    return new Promise((resolve) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', () => resolve(Buffer.concat(chunks)));
    });
}

/**
 * Shim matching the parts of Playwright's Route/Request interface that a route handler
 * uses, so the same defaultRouteHandler can run for proxied Firefox extension requests.
 *
 * `_acted` is set synchronously by the first terminal method (fulfill/abort/continue/
 * fallback) so a second call throws like Playwright; `_handled` is set only AFTER a
 * response has actually been written, so a throwing writeHead can't leave the request
 * looking handled-but-unanswered (the caller inspects the response stream instead).
 */
class FirefoxRoute {
    constructor(requestInfo, res, completion) {
        this._requestInfo = requestInfo;
        this._res = res;
        this._completion = completion;
        this._acted = false;
        this._handled = false;
        this._outcome = null; // 'fulfilled' | 'aborted' | 'continue' | 'fallback'
        this._continueOverrides = null;
        this._actionPromise = null;
    }

    _checkNotHandled() {
        if (this._acted) {
            throw new Error('Route is already handled!');
        }
    }

    request() {
        const info = this._requestInfo;
        const postData = () => (info.postDataBuffer && info.postDataBuffer.length ? info.postDataBuffer : null);
        return {
            url: () => info.url,
            method: () => info.method,
            // Proxied background requests are fetch/XHR (documents are excluded from
            // proxying by the helper's shouldProxy), so this is a reasonable fallback.
            resourceType: () => 'fetch',
            headers: () => ({ ...info.headers }),
            allHeaders: async () => ({ ...info.headers }),
            postData: () => {
                const buf = postData();
                return buf ? buf.toString('utf8') : null;
            },
            postDataBuffer: () => postData(),
            postDataJSON: () => {
                const buf = postData();
                if (!buf) return null;
                try {
                    return JSON.parse(buf.toString('utf8'));
                } catch {
                    throw new Error('Error parsing route.request().postDataJSON()');
                }
            },
        };
    }

    fulfill(options = {}) {
        this._checkNotHandled();
        this._acted = true;
        this._outcome = 'fulfilled';
        this._actionPromise = this._doFulfill(options);
        return this._actionPromise;
    }

    async _doFulfill({ status = 200, headers = {}, contentType, body, json, path: filePath } = {}) {
        // Body precedence mirrors Playwright: json (exclusive with body) then path then body.
        let outBody = body;
        if (json !== undefined) {
            if (body !== undefined) {
                throw new Error('Can specify either body or json parameters');
            }
            outBody = JSON.stringify(json);
        } else if (filePath !== undefined) {
            outBody = await fs.readFile(filePath);
        }
        if (outBody === undefined) outBody = '';

        // Lowercase header keys so the content-type/length logic below is predictable.
        const outHeaders = {};
        for (const [k, v] of Object.entries(headers)) {
            outHeaders[k.toLowerCase()] = v;
        }
        // Content-Type precedence: contentType option, then json default, then path
        // guess, then whatever headers already carried.
        if (contentType) {
            outHeaders['content-type'] = contentType;
        } else if (json !== undefined && outHeaders['content-type'] === undefined) {
            outHeaders['content-type'] = 'application/json';
        } else if (filePath !== undefined && outHeaders['content-type'] === undefined) {
            outHeaders['content-type'] = guessContentType(filePath);
        }
        if (outHeaders['content-length'] === undefined) {
            outHeaders['content-length'] = Buffer.byteLength(outBody);
        }

        this._res.writeHead(status, outHeaders);
        this._res.end(outBody);
        this._handled = true;
    }

    // Playwright's route.abort() fails the request (the extension's fetch rejects), so
    // destroy the socket with no response — unlike a 204, which would look like success.
    abort(errorCode = 'failed') {
        this._checkNotHandled();
        this._acted = true;
        this._outcome = 'aborted';
        this._completion.failure = ABORT_ERROR_TEXT[errorCode] || 'net::ERR_FAILED';
        this._res.destroy();
        this._handled = true;
    }

    // Send the request to the real origin WITHOUT consulting any other handler
    // (Playwright's continue() semantics). Overrides are applied by _runHandler.
    continue(overrides = {}) {
        this._checkNotHandled();
        this._acted = true;
        this._outcome = 'continue';
        this._continueOverrides = overrides;
    }

    // Defer to the next matching handler, then the base handler, then the origin
    // (Playwright's fallback() semantics). Overrides are warned-and-ignored.
    fallback(options = {}) {
        this._checkNotHandled();
        this._acted = true;
        this._outcome = 'fallback';
        if (options && Object.keys(options).length > 0) {
            console.warn('firefox-webext-playwright-harness: route.fallback() overrides are not applied to extension background requests');
        }
    }
}

class FirefoxWebServer {
    constructor() {
        this._server = null;
        this._port = 0;
        this._emitter = new EventEmitter();
        this._events = [];
        // Ordered [from, to] path-rewrite pairs applied when reconstructing a
        // proxied request's original URL (e.g. mapping a platform-specific config
        // filename to the one on disk). Consumer-supplied, so the server bakes in
        // no extension-specific knowledge.
        this._rewriteStaticRules = [];
        // Routes registered via the harness's wrapped context.route(), used to
        // fulfill XPCOM-redirected extension requests (e.g. config/TDS overrides).
        this._routes = [];
        this._warnedManualRedirect = false;
    }

    get port() {
        return this._port;
    }

    async start() {
        const server = http.createServer((req, res) => this._handleRequest(req, res));
        this._server = server;
        await new Promise((resolve, reject) => {
            // Listen on port 0 and read the assigned port back — race-free, unlike
            // finding a free port first and binding to it afterwards.
            server.listen(0, '127.0.0.1', () => resolve(undefined));
            server.once('error', reject);
        });
        this._port = server.address().port;
    }

    async stop() {
        const server = this._server;
        if (server) {
            await new Promise((resolve) => server.close(() => resolve(undefined)));
            this._server = null;
        }
        this._events.length = 0;
        this._routes.length = 0;
    }

    // -- Event delivery (from helper extension POSTs and this server's proxy-complete) --

    on(eventType, handler) {
        this._emitter.on(eventType, handler);
    }

    off(eventType, handler) {
        this._emitter.off(eventType, handler);
    }

    // Push an event into the buffer and notify listeners. Per-event try/catch so one
    // throwing listener (a consumer's server.on('event') handler, or the bridge on an
    // unexpected event shape) can't drop the rest of a batch.
    _emitEvent(event) {
        this._events.push(event);
        try {
            this._emitter.emit('event', event);
        } catch (e) {
            console.warn('firefox-webext-playwright-harness: event listener threw:', e);
        }
    }

    /**
     * Wait for an event matching the predicate.
     * @param {(event: object) => boolean} predicate
     * @param {number} [timeout=5000]
     * @returns {Promise<object>}
     */
    waitForEvent(predicate, timeout = 5000) {
        // Check buffered events first
        const existing = this._events.find(predicate);
        if (existing) return Promise.resolve(existing);

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this._emitter.off('event', listener);
                reject(new Error(`waitForEvent timed out after ${timeout}ms`));
            }, timeout);

            const listener = (event) => {
                if (predicate(event)) {
                    clearTimeout(timer);
                    this._emitter.off('event', listener);
                    resolve(event);
                }
            };
            this._emitter.on('event', listener);
        });
    }

    // -- URL reconstruction --

    // Ordered [from, to] string replacements applied to a proxied request's
    // reconstructed URL (e.g. a platform-specific config filename → the one the
    // consumer's route handlers expect on disk).
    setRewriteStaticRules(rules) {
        this._rewriteStaticRules = rules || [];
    }

    _rewriteStaticPath(p) {
        return this._rewriteStaticRules.reduce((acc, [from, to]) => acc.replace(from, to), p);
    }

    // -- Route handler (for proxied extension requests) --

    setRouteHandler(handler) {
        this._routeHandler = handler;
    }

    // Register a Playwright-style route (from the harness's wrapped
    // context.route) so an XPCOM-redirected extension request can be fulfilled by
    // a test handler. Most-recently-registered routes win (LIFO), like Playwright.
    registerRoute(urlPattern, handler) {
        this._routes.unshift({ pattern: urlPattern, regex: globToRegExp(urlPattern), handler });
    }

    // Remove routes registered for the pattern (and handler, when given) —
    // mirroring Playwright's context.unroute(url, handler?) semantics.
    unregisterRoute(urlPattern, handler) {
        this._routes = this._routes.filter((route) => route.pattern !== urlPattern || (handler && route.handler !== handler));
    }

    // Remove every registered route — mirroring context.unrouteAll().
    clearRoutes() {
        this._routes.length = 0;
    }

    /**
     * Run a single route handler against `requestInfo`/`res`. Returns:
     *  - 'done'      the request was concluded (fulfilled, aborted, or the handler threw)
     *  - 'continue'  the handler called continue() — go straight to the origin
     *  - 'fallback'  the handler called fallback() (or did nothing) — try the next handler
     *
     * A handler error is logged (never silently swallowed) and concluded with a 500 — or a
     * destroyed socket if the response was already partly written — so the request can
     * never hang waiting for a response that will not come.
     */
    async _runHandler(handler, requestInfo, res, completion) {
        const route = new FirefoxRoute(requestInfo, res, completion);
        try {
            await handler(route, route.request());
            if (route._actionPromise) await route._actionPromise;
        } catch (e) {
            console.warn(`firefox-webext-playwright-harness: route handler error for ${requestInfo.url}:`, e);
            completion.failure = completion.failure || 'net::ERR_FAILED';
            if (!res.headersSent) {
                try {
                    res.writeHead(500);
                    res.end('Route handler error');
                } catch {
                    res.destroy();
                }
            } else if (!res.writableEnded) {
                res.destroy();
            }
            return 'done';
        }
        if (route._outcome === 'continue') {
            // Apply continue() overrides onto the request _proxyToOrigin will send.
            const o = route._continueOverrides || {};
            if (o.url !== undefined) requestInfo.url = o.url;
            if (o.method !== undefined) requestInfo.method = o.method;
            if (o.headers !== undefined) requestInfo.headers = { ...o.headers };
            if (o.postData !== undefined) {
                requestInfo.postDataBuffer = Buffer.isBuffer(o.postData) ? o.postData : Buffer.from(String(o.postData));
            }
            return 'continue';
        }
        if (route._outcome === 'fulfilled' || route._outcome === 'aborted') {
            return 'done';
        }
        // fallback() or a handler that did nothing — try the next handler.
        return 'fallback';
    }

    // -- Internal --

    _handleRequest(req, res) {
        if (req.method === 'POST' && req.url === '/events') {
            return this._handleEventPost(req, res);
        }
        if (req.url.startsWith('/proxy/')) {
            return this._handleProxiedRequest(req, res);
        }
        res.writeHead(404);
        res.end('Not found');
    }

    async _handleEventPost(req, res) {
        let events;
        try {
            events = JSON.parse((await readBody(req)).toString('utf8'));
        } catch {
            res.writeHead(400);
            res.end('Bad request');
            return;
        }
        if (Array.isArray(events)) {
            for (const event of events) {
                this._emitEvent(event);
            }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
    }

    async _handleProxiedRequest(req, res) {
        // Reconstruct from /proxy/<channelId>/<scheme>/<host>/<path>?<query> — the XPCOM
        // helper encodes the original channel id and scheme as leading path segments.
        // The channel id lets us key the terminal 'proxy-complete' event by channel (the
        // server alone knows the real outcome); the rest reconstructs the original URL,
        // to which consumer-supplied path rewrites are then applied.
        const withoutPrefix = req.url.slice('/proxy/'.length);
        const match = withoutPrefix.match(/^([^/]+)\/(https?)\//);
        if (!match) {
            res.writeHead(400);
            res.end('Bad proxy path');
            return;
        }
        const channelId = match[1];
        const scheme = match[2];
        const originalUrl = this._rewriteStaticPath(`${scheme}://${withoutPrefix.slice(match[0].length)}`);

        // Build the request view handlers and the origin proxy see; strip the local-hop
        // headers and re-point host at the real origin.
        const headers = { ...req.headers };
        delete headers.host;
        delete headers.connection;
        delete headers['content-length'];
        // The local hop may be chunked; the body is buffered below and re-sent with its
        // own framing, so this header must not survive onto the reconstructed request.
        delete headers['transfer-encoding'];
        try {
            headers.host = new URL(originalUrl).host;
        } catch {
            // originalUrl always parses (the scheme matched), but stay defensive.
        }
        const body = await readBody(req);
        const requestInfo = { url: originalUrl, method: req.method || 'GET', headers, postDataBuffer: body };

        const completion = { channelId, failure: null, redirectUrl: null };
        if (channelId) {
            // 'close' fires after a normal finish AND on a premature destroy (abort /
            // mid-stream error); writableFinished disambiguates success from failure.
            res.on('close', () => {
                this._emitEvent({
                    source: 'server',
                    type: 'proxy-complete',
                    channelId,
                    url: requestInfo.url,
                    method: requestInfo.method,
                    statusCode: res.writableFinished ? res.statusCode : undefined,
                    failure: completion.failure || (res.writableFinished ? null : 'net::ERR_FAILED'),
                    redirectUrl: completion.redirectUrl || null,
                });
            });
        }

        // Test-registered routes (LIFO) first, then the base route handler, then origin.
        let outcome = 'fallback';
        for (const { regex, handler } of this._routes) {
            if (!regex.test(requestInfo.url)) continue;
            outcome = await this._runHandler(handler, requestInfo, res, completion);
            if (outcome !== 'fallback') break;
        }
        if (outcome === 'fallback' && this._routeHandler) {
            outcome = await this._runHandler(this._routeHandler, requestInfo, res, completion);
        }
        if (outcome !== 'done') {
            // 'continue' (skip everything and hit the network) or nothing handled it.
            await this._proxyToOrigin(requestInfo, res, completion);
        }
    }

    async _proxyToOrigin(requestInfo, res, completion) {
        try {
            const headers = { ...requestInfo.headers };
            // Drop headers tied to the local hop; let fetch recompute them. (fetch
            // rejects a forwarded transfer-encoding and frames the body itself.)
            delete headers.host;
            delete headers.connection;
            delete headers['content-length'];
            delete headers['transfer-encoding'];
            delete headers['accept-encoding'];
            const method = requestInfo.method || 'GET';
            const init = { method, headers, redirect: 'manual' };
            if (method !== 'GET' && method !== 'HEAD' && requestInfo.postDataBuffer && requestInfo.postDataBuffer.length) {
                init.body = requestInfo.postDataBuffer;
            }
            let upstream = await fetch(requestInfo.url, init);
            // Some older undici versions surface a manual redirect as an opaque status-0
            // response; fall back to following redirects so we still return something.
            if (upstream.status === 0) {
                if (!this._warnedManualRedirect) {
                    this._warnedManualRedirect = true;
                    console.warn('firefox-webext-playwright-harness: manual redirect unsupported by this fetch; following redirects instead');
                }
                upstream = await fetch(requestInfo.url, { ...init, redirect: 'follow' });
            }

            const respHeaders = {};
            upstream.headers.forEach((value, key) => {
                // Skip headers that don't apply to a re-sent (decoded) response; set-cookie
                // is relayed separately as an array so multiple cookies survive.
                if (['content-encoding', 'transfer-encoding', 'content-length', 'connection', 'set-cookie'].includes(key)) return;
                respHeaders[key] = value;
            });
            const setCookies = upstream.headers.getSetCookie ? upstream.headers.getSetCookie() : [];
            if (setCookies.length) {
                respHeaders['set-cookie'] = setCookies;
            }

            // Relay a 3xx rather than following it, so the extension sees the redirect as
            // it would under Chrome's route.continue(). Resolve Location absolute against
            // the request URL (a relative Location would otherwise resolve against the
            // proxy URL and escape re-proxying).
            if (upstream.status >= 300 && upstream.status < 400) {
                const location = upstream.headers.get('location');
                if (location) {
                    const absolute = new URL(location, requestInfo.url).href;
                    respHeaders.location = absolute;
                    completion.redirectUrl = absolute;
                }
            }

            res.writeHead(upstream.status, respHeaders);
            if (upstream.body) {
                // Stream the body rather than buffering, so a streaming/long response
                // doesn't hang waiting for the whole payload.
                await pipeline(Readable.fromWeb(upstream.body), res);
            } else {
                res.end();
            }
        } catch (e) {
            console.warn(`firefox-webext-playwright-harness: proxy-to-origin error for ${requestInfo.url}:`, e);
            completion.failure = 'net::ERR_FAILED';
            if (!res.headersSent) {
                res.writeHead(502);
                res.end('Proxy error');
            } else if (!res.writableEnded) {
                res.destroy();
            }
        }
    }
}

module.exports = { FirefoxWebServer, globToRegExp };
