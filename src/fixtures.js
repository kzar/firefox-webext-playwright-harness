/**
 * Firefox harness Playwright fixtures.
 *
 * `applyFirefoxHarness(test, opts)` is the single integration point: the main
 * repo's `playwrightHarness.js` calls it once (only when running Firefox) to
 * layer the Firefox fixture implementations on top of the base (Chrome) test.
 * Because it's applied only in Firefox mode, these overrides fully replace the
 * Chrome fixtures and never need to delegate to them.
 */

const { createFirefoxContext, cleanupFirefoxContext, FirefoxBackgroundPage } = require('./harness.js');
const { findFreeTcpPort } = require('./web-ext-rdp.js');
const { NetworkEventBridge } = require('./network-bridge.js');
const { wrapWithNetworkBridge } = require('./proxies.js');
const { installAddScriptTagPatch } = require('./script-tag.js');

/**
 * @param {import('@playwright/test').TestType<any, any>} test
 * @param {object} opts
 * @param {(route: any) => any} opts.defaultRouteHandler - Playwright route handler for the
 *   extension's pages and its redirected background requests.
 *
 * Per-extension data (addonId, extensionPath, rewriteStaticRules, postInstallPages) is read at
 * runtime from the `firefoxHarnessConfig` Playwright option, which the consumer supplies via their
 * Firefox config's `use` block. `postInstallPages` is an optional array of URL substrings/RegExps
 * for tab(s) the extension opens on install; the page fixture waits for them to open before the
 * first newPage() so they can't race Juggler's new-window "exactly one tab" check.
 */
function applyFirefoxHarness(test, { defaultRouteHandler }) {
    return test.extend({
        // Per-extension config, supplied by the consumer's Playwright config `use` block. Read at
        // fixture runtime (not module load), which is why it's an option rather than an argument.
        firefoxHarnessConfig: [{}, { option: true }],

        // RDP port for Firefox debugging. Each test gets a fresh port to ensure
        // complete isolation.
        rdpPort: [
            // eslint-disable-next-line no-empty-pattern
            async ({}, use) => {
                await use(await findFreeTcpPort());
            },
            { scope: 'test' },
        ],

        // The Firefox extension's BrowserContext.
        async context({ rdpPort, firefoxHarnessConfig }, use) {
            const { addonId, extensionPath, rewriteStaticRules } = firefoxHarnessConfig;

            const { context } = await createFirefoxContext(rdpPort, extensionPath, addonId, {
                routeHandler: defaultRouteHandler,
                rewriteStaticRules,
            });

            await context.route('**/*', defaultRouteHandler);

            // Surface XPCOM network events as Playwright-style request events.
            // The bridge is shared with the page fixture (one global stream).
            const bridge = new NetworkEventBridge(context._firefoxWebServer);
            context._firefoxBridge = bridge;

            // The background page is just an RDP wrapper over actors that exist as
            // soon as the context does, so create it here (not only in the
            // backgroundPage fixture). That lets config/TDS overrides always poke
            // the extension to re-fetch, even for tests that never use the
            // backgroundPage fixture directly.
            context._firefoxBgPage = new FirefoxBackgroundPage(
                context._rdpClient,
                context._firefoxBackgroundConsoleActor,
                context._firefoxEvalResults,
            );

            // context.route() additionally registers the route with the web server,
            // so the extension's XPCOM-redirected background requests (config/TDS)
            // are matched by the same handler.
            const onRoute = (pattern, handler) => {
                // Only string globs map to the extension's XPCOM-redirected requests
                // on the web server. RegExp/function matchers are content-page
                // matchers — the real context.route() (already called) handles those
                // via Juggler; skip them here.
                if (typeof pattern !== 'string') return;
                context._firefoxWebServer.registerRoute(pattern, handler);
            };

            await use(wrapWithNetworkBridge(context, bridge, { onRoute }));

            bridge.dispose();
            // cleanupFirefoxContext closes the context internally.
            await cleanupFirefoxContext(context);
        },

        // The extension's background page (created in the context fixture); wraps
        // RDP evaluate() so our helpers can run code in the background context.
        async backgroundPage({ context }, use) {
            await use(context._firefoxBgPage);
        },

        async page({ context, firefoxHarnessConfig }, use) {
            // If the extension opens tab(s) on install (e.g. a post-install page), wait for
            // them to appear — in the initial window — before opening the test's window, so
            // they can't race Juggler's new-window "exactly one tab" assertion. The URL
            // patterns are supplied by the consumer (firefoxHarnessConfig.postInstallPages,
            // an array of substrings or RegExps), so the harness stays extension-agnostic.
            // Deliberately in the page fixture (runs after beforeEach hooks) so it never
            // perturbs install-flow timing for tests that observe it (e.g. ATB exti
            // counting). Bounded; if no matching tab appears before the deadline we proceed.
            const postInstallPages = firefoxHarnessConfig.postInstallPages || [];
            if (postInstallPages.length) {
                const isPostInstall = (url) =>
                    postInstallPages.some((p) => (p instanceof RegExp ? p.test(url) : url.includes(p)));
                const deadline = Date.now() + 5000;
                while (!context.pages().some((pg) => isPostInstall(pg.url())) && Date.now() < deadline) {
                    await new Promise((resolve) => setTimeout(resolve, 50));
                }
            }
            const page = await context.newPage();
            // Firefox's CSP blocks Playwright's addScriptTag; patch it (once) on
            // the Page/Frame prototypes so the shared addScriptTag helper works
            // unchanged on both a page and a page.frames() frame.
            installAddScriptTagPatch(page);
            // `context` is the wrapped proxy; `_firefoxBridge` passes through to
            // the real context's bridge so page + context share one stream.
            await use(wrapWithNetworkBridge(page, context._firefoxBridge));
        },

        // wraps the 'route' function in a manifest agnostic way
        async routeExtensionRequests({ context }, use) {
            await use(context.route.bind(context));
        },

        // Use this for listening and modifying network events.
        async backgroundNetworkContext({ context }, use) {
            await use(context);
        },
    });
}

module.exports = { applyFirefoxHarness };
