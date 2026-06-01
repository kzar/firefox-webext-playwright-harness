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
const { EventEmitter } = require('events');
const { findFreeTcpPort } = require('./web-ext-rdp.js');

// Convert a Playwright-style URL glob (as passed to `context.route`) into a
// RegExp, so the web server can match XPCOM-redirected extension requests
// against routes registered through the harness's wrapped context. `**` matches
// across path segments, `*` within a segment.
function globToRegExp(glob) {
    const escapeRe = (s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    const body = glob
        .split('**')
        .map((chunk) => escapeRe(chunk).replace(/\*/g, '[^/]*').replace(/\?/g, '.'))
        .join('.*');
    return new RegExp('^' + body + '$');
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
 * Minimal shim matching Playwright's Route interface, used to run the same
 * defaultRouteHandler for proxied Firefox extension requests.
 */
class FirefoxRoute {
    constructor(originalUrl, res) {
        this._originalUrl = originalUrl;
        this._res = res;
        this._handled = false;
        this._continued = false;
    }

    request() {
        const url = this._originalUrl;
        return { url: () => url };
    }

    fulfill({ status = 200, body = '', headers = {} } = {}) {
        this._handled = true;
        this._res.writeHead(status, headers);
        this._res.end(body);
    }

    // Signals "not handled here" so the caller falls through to the next matching
    // route, then the base route handler / disk serving.
    continue() {
        this._continued = true;
    }

    abort() {
        this._handled = true;
        this._res.writeHead(204);
        this._res.end();
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
    }

    get port() {
        return this._port;
    }

    async start() {
        this._port = await findFreeTcpPort();
        const server = http.createServer((req, res) => this._handleRequest(req, res));
        this._server = server;
        await new Promise((resolve, reject) => {
            server.listen(this._port, '127.0.0.1', () => resolve(undefined));
            server.once('error', reject);
        });
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

    // -- Event delivery (from helper extension POSTs) --

    on(eventType, handler) {
        this._emitter.on(eventType, handler);
    }

    off(eventType, handler) {
        this._emitter.off(eventType, handler);
    }

    getEvents(filter) {
        if (filter) {
            return this._events.filter(filter);
        }
        return this._events.slice();
    }

    clearEvents() {
        this._events.length = 0;
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
        this._routes.unshift({ regex: globToRegExp(urlPattern), handler });
    }

    /**
     * Run registered routes against a reconstructed original URL. Returns true if
     * a route fulfilled (or aborted) the request; false if none handled it (so
     * the caller should fall back to the base handler / disk).
     */
    async _runRoutes(originalUrl, res) {
        for (const { regex, handler } of this._routes) {
            if (!regex.test(originalUrl)) continue;
            const route = new FirefoxRoute(originalUrl, res);
            try {
                await handler(route);
            } catch (e) {
                if (!route._handled) {
                    res.writeHead(500);
                    res.end('Route handler error');
                }
                return true;
            }
            if (route._handled) return true;
            // route.continue() → fall through to the next matching route.
        }
        return false;
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

    _handleEventPost(req, res) {
        let body = '';
        req.on('data', (chunk) => {
            body += chunk;
        });
        req.on('end', () => {
            try {
                const events = JSON.parse(body);
                if (Array.isArray(events)) {
                    for (const event of events) {
                        this._events.push(event);
                        this._emitter.emit('event', event);
                        if (event.type) {
                            this._emitter.emit(event.type, event);
                        }
                    }
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end('{"ok":true}');
            } catch (e) {
                res.writeHead(400);
                res.end('Bad request');
            }
        });
    }

    async _handleProxiedRequest(req, res) {
        // Reconstruct original URL from /proxy/<host>/<path>?<query>, applying any
        // consumer-supplied path rewrites so route handlers see the on-disk name.
        const withoutPrefix = req.url.slice('/proxy/'.length);
        const originalUrl = this._rewriteStaticPath('https://' + withoutPrefix);

        // Buffer the request body up-front so it can be forwarded if we fall
        // through to the real origin (e.g. a POST the route handlers don't mock).
        const body = await readBody(req);

        // Test-registered routes take precedence over the base route handler.
        if (await this._runRoutes(originalUrl, res)) return;

        if (this._routeHandler) {
            const route = new FirefoxRoute(originalUrl, res);
            try {
                await this._routeHandler(route);
            } catch (e) {
                if (!route._handled) {
                    res.writeHead(500);
                    res.end('Route handler error');
                }
                return;
            }
            if (route._handled) return;
            // route.continue() → fall through to the real origin below.
        }

        // Nothing mocked this request: proxy it to the real origin, mirroring
        // Chrome's `route.continue()` (which lets the request hit the network).
        await this._proxyToOrigin(req, originalUrl, body, res);
    }

    async _proxyToOrigin(req, originalUrl, body, res) {
        try {
            const headers = { ...req.headers };
            // Drop headers tied to the local hop; let fetch recompute them.
            delete headers.host;
            delete headers.connection;
            delete headers['content-length'];
            delete headers['accept-encoding'];
            const method = req.method || 'GET';
            const init = { method, headers, redirect: 'follow' };
            if (method !== 'GET' && method !== 'HEAD' && body && body.length) {
                init.body = body;
            }
            const upstream = await fetch(originalUrl, init);
            const buf = Buffer.from(await upstream.arrayBuffer());
            const respHeaders = {};
            upstream.headers.forEach((value, key) => {
                // Skip headers that don't apply to a buffered, decoded response.
                if (['content-encoding', 'transfer-encoding', 'content-length', 'connection'].includes(key)) return;
                respHeaders[key] = value;
            });
            res.writeHead(upstream.status, respHeaders);
            res.end(buf);
        } catch (e) {
            res.writeHead(502);
            res.end('Proxy error');
        }
    }
}

module.exports = { FirefoxWebServer };
