// Tiny static server for the network spec. Started by Playwright's `webServer`.
//
// Serving the page itself from here means the page's fetches are same-origin,
// which sidesteps cross-origin / local-network restrictions on page-initiated
// requests.

import http from 'node:http';
import { SERVER_PORT } from './helpers/constants.mjs';

const PAGE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Harness test page</title></head>
<body><h1>Harness test page</h1></body></html>`;

const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, `http://localhost:${SERVER_PORT}`);

    if (pathname === '/' || pathname === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(PAGE_HTML);
        return;
    }

    // /ok succeeds; /blocked is cancelled by the test extension before it
    // arrives — if it ever reaches here we still answer 200 so a missing block
    // shows up as an assertion failure rather than a network error.
    if (pathname === '/ok' || pathname === '/blocked') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
        return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
});

server.listen(SERVER_PORT, '127.0.0.1', () => {
    // eslint-disable-next-line no-console
    console.log(`Harness test server listening on http://localhost:${SERVER_PORT}`);
});
