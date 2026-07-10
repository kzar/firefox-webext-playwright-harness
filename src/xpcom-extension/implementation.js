/**
 * WebExtension Experiment implementation for XPCOM network observation.
 *
 * Runs in the addon_parent (chrome) process with full XPCOM access.
 * Observes HTTP request lifecycle via nsIObserverService and fires events
 * to the WebExtension background script. Also redirects the extension-under-
 * test's background requests to the local harness server (see setProxyOrigin).
 *
 * Requires: extensions.experiments.enabled = true (Firefox Nightly)
 */

'use strict';

/* global ExtensionAPI, ExtensionCommon, Ci, Services */

this.networkObserver = class extends ExtensionAPI {
    getAPI(context) {
        // When set (e.g. "http://127.0.0.1:PORT"), every extension-initiated
        // http(s) request is redirected to `${proxyOrigin}/proxy/<scheme>/<host>/<path>`,
        // where the harness web server runs the consumer's route handlers (and
        // falls back to the real origin). Playwright/Juggler can't intercept the
        // extension's background requests, so we redirect them here instead.
        let proxyOrigin = null;

        // nsIContentPolicy.TYPE_DOCUMENT — top-level navigations (e.g. the
        // extension's post-install page) must reach their real URL, not the proxy.
        const TYPE_DOCUMENT = 6;

        // Decide whether a request (already turned into `details`) is an
        // extension-initiated http(s) request that should be proxied. Skips
        // top-level navigations and anything already pointing at a local server
        // (the harness server or test server) to avoid redirect loops.
        function shouldProxy(details) {
            return (
                typeof details.originUrl === 'string' &&
                details.originUrl.startsWith('moz-extension://') &&
                /^https?:\/\//.test(details.url) &&
                details.contentPolicyType !== TYPE_DOCUMENT &&
                !/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(details.url)
            );
        }

        // Track active fire callbacks from EventManager listeners
        let activeFire = null;

        // Helper to extract details from an nsIHttpChannel
        function extractChannelDetails(channel, eventType) {
            try {
                const httpChannel = channel.QueryInterface(Ci.nsIHttpChannel);
                const details = {
                    type: eventType,
                    url: httpChannel.URI.spec,
                    method: httpChannel.requestMethod,
                };

                try {
                    details.channelId = '' + channel.QueryInterface(Ci.nsIIdentChannel).channelId;
                } catch (e) {}

                if (eventType !== 'request') {
                    try {
                        details.statusCode = httpChannel.responseStatus;
                    } catch (e) {
                        // Not available yet
                    }

                    if (details.statusCode >= 300 && details.statusCode < 400) {
                        try {
                            details.redirectUrl = httpChannel.getResponseHeader('Location');
                        } catch (e) {}
                    }
                }

                try {
                    const loadInfo = httpChannel.loadInfo;
                    if (loadInfo && loadInfo.triggeringPrincipal) {
                        const uri = loadInfo.triggeringPrincipal.URI;
                        if (uri) {
                            details.originUrl = uri.spec;
                        }
                    }
                    if (loadInfo) {
                        try {
                            details.contentPolicyType = loadInfo.externalContentPolicyType;
                        } catch (e) {}
                    }
                } catch (e) {
                    // loadInfo not always available
                }

                return details;
            } catch (e) {
                return null;
            }
        }

        function fireEvent(details) {
            if (activeFire) {
                activeFire.async(details);
            }
        }

        // Should this request/response/stop event be suppressed because it belongs to
        // the harness's own traffic — the helper's /events POSTs or the redirected
        // /proxy/ channel itself? Those all target proxyOrigin; reporting them as
        // extension activity would loop and confuse the bridge.
        function isHarnessTraffic(details) {
            return proxyOrigin && details && typeof details.url === 'string' && details.url.startsWith(proxyOrigin);
        }

        // XPCOM observers - always active for redirect support
        const requestObserver = {
            observe(subject) {
                try {
                    const channel = subject.QueryInterface(Ci.nsIHttpChannel);
                    const details = extractChannelDetails(channel, 'request');

                    // Redirect extension-initiated requests to the harness server,
                    // encoding both the original channel id and scheme as leading path
                    // segments (/proxy/<channelId>/<scheme>/<host>/<path>). The channel id
                    // lets the harness server key its terminal 'proxy-complete' event by
                    // channel and report the true outcome; carrying it in the URL (which
                    // redirectTo honours exactly) is collision-free and, unlike a request
                    // header, survives the internal redirect reliably. The scheme is kept
                    // so the server can reconstruct the original URL — http must not come
                    // back as https.
                    if (proxyOrigin && details && shouldProxy(details)) {
                        const newUrl =
                            proxyOrigin + '/proxy/' + details.channelId + '/' + details.url.replace(/^(https?):\/\//, '$1/');
                        channel.redirectTo(Services.io.newURI(newUrl));
                        details.proxied = true;
                    }

                    // Suppress the harness's own /events and /proxy/ channels, but still
                    // report the proxied request itself (its url is the original origin,
                    // not proxyOrigin, so it isn't filtered here).
                    if (isHarnessTraffic(details)) {
                        return;
                    }

                    if (details) {
                        fireEvent(details);
                    }
                } catch (e) {
                    // Ignore channels that can't be cast to nsIHttpChannel
                }
            },
        };

        const responseObserver = {
            observe(subject) {
                const details = extractChannelDetails(subject, 'response');
                if (isHarnessTraffic(details)) return;
                if (details) {
                    fireEvent(details);
                }
            },
        };

        const cachedResponseObserver = {
            observe(subject) {
                const details = extractChannelDetails(subject, 'cached-response');
                if (isHarnessTraffic(details)) return;
                if (details) {
                    fireEvent(details);
                }
            },
        };

        const stopObserver = {
            observe(subject) {
                try {
                    const channel = subject.QueryInterface(Ci.nsIHttpChannel);
                    const request = subject.QueryInterface(Ci.nsIRequest);
                    const details = extractChannelDetails(channel, 'stop');
                    if (details) {
                        details.requestStatus = request.status;
                        // Suppress the harness server's own *successful* stops, but let a
                        // FAILING stop of a server-bound channel through so a dead harness
                        // server can still surface as a failure downstream.
                        if (isHarnessTraffic(details) && request.status === 0) {
                            return;
                        }
                        fireEvent(details);
                    }
                } catch (e) {}
            },
        };

        // Register XPCOM observers
        const observerService = Services.obs;
        observerService.addObserver(requestObserver, 'http-on-modify-request', false);
        observerService.addObserver(responseObserver, 'http-on-examine-response', false);
        observerService.addObserver(cachedResponseObserver, 'http-on-examine-cached-response', false);
        observerService.addObserver(stopObserver, 'http-on-stop-request', false);

        // Clean up on extension shutdown
        context.callOnClose({
            close() {
                observerService.removeObserver(requestObserver, 'http-on-modify-request');
                observerService.removeObserver(responseObserver, 'http-on-examine-response');
                observerService.removeObserver(cachedResponseObserver, 'http-on-examine-cached-response');
                observerService.removeObserver(stopObserver, 'http-on-stop-request');
            },
        });

        return {
            networkObserver: {
                onRequestActivity: new ExtensionCommon.EventManager({
                    context,
                    name: 'networkObserver.onRequestActivity',
                    register(fire) {
                        activeFire = fire;
                        return () => {
                            activeFire = null;
                        };
                    },
                }).api(),

                async setProxyOrigin(origin) {
                    proxyOrigin = origin || null;
                },
            },
        };
    }
};
