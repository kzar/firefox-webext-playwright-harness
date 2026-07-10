/**
 * Wrap a Playwright `Page` or `BrowserContext` so that network event
 * subscriptions (`requestfinished` / `requestfailed`) are served from the
 * Firefox NetworkEventBridge (sourced from the reliable XPCOM observer) instead
 * of Juggler, while every other property/method delegates to the real object.
 *
 * The wrapped object is only ever handed to test/helper code — never back into a
 * Playwright API — so it's safe to Proxy. The one rule that matters: methods
 * must run with `this` bound to the REAL target, or Playwright's private-field
 * access throws.
 */

// Events the bridge owns. Other events (e.g. 'page', 'pageerror', 'request',
// 'response') pass through to the real object unchanged.
const BRIDGE_EVENTS = new Set(['requestfinished', 'requestfailed']);

const SUBSCRIBE_METHODS = new Set(['on', 'addListener']);
const UNSUBSCRIBE_METHODS = new Set(['off', 'removeListener']);

/**
 * @template T
 * @param {T} target - real Playwright Page or BrowserContext
 * @param {import('./network-bridge.js').NetworkEventBridge} bridge
 * @param {{
 *   onRoute?: (pattern: any, handler: any) => Promise<void>,
 *   onUnroute?: (pattern: any, handler: any) => Promise<void>,
 *   onUnrouteAll?: () => Promise<void>,
 * }} [options]
 *   onRoute / onUnroute / onUnrouteAll (context only): also register/unregister
 *   the route with the harness web server, so XPCOM-redirected extension
 *   requests are matched by the same handlers as content-page requests.
 * @returns {T}
 */
function wrapWithNetworkBridge(target, bridge, { onRoute, onUnroute, onUnrouteAll } = {}) {
    const proxy = new Proxy(target, {
        get(t, prop) {
            if (SUBSCRIBE_METHODS.has(prop) || UNSUBSCRIBE_METHODS.has(prop) || prop === 'once') {
                return (event, listener, ...rest) => {
                    if (BRIDGE_EVENTS.has(event)) {
                        if (UNSUBSCRIBE_METHODS.has(prop)) {
                            bridge.off(event, listener);
                        } else if (prop === 'once') {
                            bridge.once(event, listener);
                        } else {
                            bridge.on(event, listener);
                        }
                        return proxy;
                    }
                    // Bind to the real target so Playwright's private fields work.
                    Reflect.apply(t[prop], t, [event, listener, ...rest]);
                    return proxy;
                };
            }
            if (onRoute && prop === 'route') {
                return async (...args) => {
                    // Register on the real context (content-page routing) AND with
                    // the web server (extension background requests via XPCOM).
                    if (args[2] !== undefined) {
                        // The web server ignores route options; content-page routing
                        // still honours them via the real context.route().
                        console.warn('firefox-webext-playwright-harness: route() options are not applied to extension background requests');
                    }
                    await Reflect.apply(t.route, t, args);
                    await onRoute(args[0], args[1]);
                };
            }
            if (onUnroute && prop === 'unroute') {
                return async (...args) => {
                    await Reflect.apply(t.unroute, t, args);
                    await onUnroute(args[0], args[1]);
                };
            }
            if (onUnrouteAll && prop === 'unrouteAll') {
                return async (...args) => {
                    await Reflect.apply(t.unrouteAll, t, args);
                    await onUnrouteAll();
                };
            }
            const value = Reflect.get(t, prop, t);
            return typeof value === 'function' ? value.bind(t) : value;
        },
    });
    return proxy;
}

module.exports = { wrapWithNetworkBridge };
