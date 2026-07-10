/**
 * Background script for the Firefox Playwright Harness reporter helper extension.
 *
 * - Subscribes to XPCOM network events via the networkObserver experiment API
 * - Buffers events and flushes them to the local test server via HTTP POST
 * - Configures redirect rules (from config.json) to route requests to the local server
 */

'use strict';

(async function init() {
    // Read config (written at runtime by the test harness)
    let config;
    try {
        const configUrl = browser.runtime.getURL('config.json');
        const resp = await fetch(configUrl);
        config = await resp.json();
    } catch (e) {
        console.error('[Firefox Playwright Harness] Failed to read config.json:', e);
        return;
    }

    const SERVER_URL = `http://127.0.0.1:${config.port}`;
    const FLUSH_INTERVAL = 50;

    let eventBuffer = [];
    let flushTimer = null;
    // Flushes chain on this promise so /events POSTs can't overtake each other on
    // separate connections — the server (and the network bridge behind it) relies
    // on request/response/stop events arriving in order.
    let flushChain = Promise.resolve();

    // -- Event flushing --

    async function doFlush() {
        if (eventBuffer.length === 0) return;
        const batch = eventBuffer;
        eventBuffer = [];
        try {
            await fetch(`${SERVER_URL}/events`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(batch),
            });
        } catch (e) {
            // Server may be briefly unreachable — re-buffer the batch and retry on
            // the next scheduled flush rather than stranding the events.
            eventBuffer = batch.concat(eventBuffer);
            scheduleFlush();
        }
    }

    function flushEvents() {
        flushChain = flushChain.then(doFlush);
        return flushChain;
    }

    function scheduleFlush() {
        if (!flushTimer) {
            flushTimer = setTimeout(() => {
                flushTimer = null;
                flushEvents();
            }, FLUSH_INTERVAL);
        }
    }

    function pushEvent(event) {
        eventBuffer.push(event);
        scheduleFlush();
    }

    function pushAndFlush(event) {
        eventBuffer.push(event);
        // Clear any pending timer and flush immediately for terminal events
        if (flushTimer) {
            clearTimeout(flushTimer);
            flushTimer = null;
        }
        flushEvents();
    }

    // Collected startup failures, reported in the ready event so the harness can
    // fail fast with a real explanation instead of opaque downstream timeouts.
    const startupErrors = [];

    if (typeof browser.networkObserver === 'undefined') {
        startupErrors.push('networkObserver experiment API unavailable — is the harness omni.ja patch applied (globalSetup)?');
    } else {
        // -- Configure request proxying --
        // Redirect the extension-under-test's background requests to the local test
        // server, so the consumer's Playwright route handlers can serve them.
        try {
            await browser.networkObserver.setProxyOrigin(SERVER_URL);
        } catch (e) {
            startupErrors.push(`setProxyOrigin failed: ${(e && e.message) || String(e)}`);
        }

        // -- XPCOM network observer events --
        try {
            browser.networkObserver.onRequestActivity.addListener((details) => {
                // Skip the helper's own requests to the local server to avoid infinite
                // loops (flush→fetch→XPCOM event→flush→…). Exception: let a FAILING stop
                // of a server-bound channel through so a dead harness server can still
                // surface as a failure (mirrors implementation.js's stopObserver; this is
                // a redundant guard since implementation.js already filters this traffic).
                if (details.url && details.url.startsWith(SERVER_URL) && !(details.type === 'stop' && details.requestStatus)) {
                    return;
                }

                const isTerminal = details.type !== 'request';
                const push = isTerminal ? pushAndFlush : pushEvent;
                push({
                    source: 'xpcom',
                    type: details.type,
                    url: details.url,
                    method: details.method,
                    statusCode: details.statusCode,
                    originUrl: details.originUrl,
                    channelId: details.channelId,
                    contentPolicyType: details.contentPolicyType,
                    redirectUrl: details.redirectUrl,
                    requestStatus: details.requestStatus,
                    proxied: details.proxied,
                });
            });
        } catch (e) {
            startupErrors.push(`onRequestActivity.addListener failed: ${(e && e.message) || String(e)}`);
        }
    }

    for (const message of startupErrors) {
        console.error(`[Firefox Playwright Harness] ${message}`);
    }

    // -- Signal readiness (including any startup failures) --
    pushAndFlush({ type: 'ready', source: 'helper', errors: startupErrors });
})();
