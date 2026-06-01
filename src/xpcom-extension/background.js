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

    // -- Event flushing --

    async function flushEvents() {
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
            // Server may have shut down, re-buffer events
            eventBuffer = batch.concat(eventBuffer);
        }
    }

    function scheduleFlush() {
        if (!flushTimer) {
            flushTimer = setTimeout(async () => {
                flushTimer = null;
                await flushEvents();
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

    // -- Configure request proxying --
    // Redirect the extension-under-test's background requests to the local test
    // server, so the consumer's Playwright route handlers can serve them.
    try {
        await browser.networkObserver.setProxyOrigin(SERVER_URL);
    } catch (e) {
        console.error('[Firefox Playwright Harness] Failed to set proxy origin:', e);
    }

    // -- XPCOM network observer events --
    try {
        browser.networkObserver.onRequestActivity.addListener((details) => {
            // Skip the helper's own requests to the local server to avoid
            // infinite loops (flush→fetch→XPCOM event→flush→…)
            if (details.url && details.url.startsWith(SERVER_URL)) return;

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
            });
        });
    } catch (e) {
        console.error('[Firefox Playwright Harness] Failed to register XPCOM listener:', e);
    }

    // -- Signal readiness --
    pushAndFlush({ type: 'ready', source: 'helper' });
})();
