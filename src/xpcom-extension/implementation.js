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
        // http(s) request is redirected to `${proxyOrigin}/proxy/<host>/<path>`,
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

        // XPCOM observers - always active for redirect support
        const requestObserver = {
            observe(subject) {
                try {
                    const channel = subject.QueryInterface(Ci.nsIHttpChannel);
                    const details = extractChannelDetails(channel, 'request');

                    // Redirect extension-initiated requests to the harness server.
                    let redirected = false;
                    if (proxyOrigin && details && shouldProxy(details)) {
                        const newUrl = proxyOrigin + '/proxy/' + details.url.replace(/^https?:\/\//, '');
                        channel.redirectTo(Services.io.newURI(newUrl));
                        redirected = true;
                    }

                    if (details) {
                        fireEvent(details);
                    }

                    // For redirected channels, fire a synthetic response event.
                    // After redirectTo(), the redirect target's response/stop
                    // events use the new URL which gets filtered by SERVER_URL
                    // in background.js, leaving the original pending entry
                    // unresolved. This synthetic event lets event consumers
                    // (like logPageRequestsFirefox) resolve the entry.
                    if (redirected && details) {
                        fireEvent({
                            type: 'response',
                            url: details.url,
                            channelId: details.channelId,
                            method: details.method,
                            redirectUrl: 'internal-redirect',
                        });
                    }
                } catch (e) {
                    // Ignore channels that can't be cast to nsIHttpChannel
                }
            },
        };

        const responseObserver = {
            observe(subject) {
                const details = extractChannelDetails(subject, 'response');
                if (details) {
                    fireEvent(details);
                }
            },
        };

        const cachedResponseObserver = {
            observe(subject) {
                const details = extractChannelDetails(subject, 'cached-response');
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
