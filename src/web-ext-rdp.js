/**
 * Firefox Remote Debugging Protocol (RDP) Client and Utilities
 *
 * This file is vendored from web-ext (https://github.com/mozilla/web-ext)
 * Sources:
 *   - src/firefox/rdp-client.js (RDP client implementation)
 *   - src/firefox/remote.js (findFreeTcpPort utility)
 * Version: 8.9.0
 * License: MPL-2.0 (Mozilla Public License 2.0)
 *
 * Modifications to rdp-client.js:
 * - Changed _handleMessage to emit all non-response messages as 'unsolicited-event'
 *   (more permissive than original, needed for extension debugging messages)
 * - Removed UNSOLICITED_EVENTS set (no longer needed)
 * - Removed domain usage for simpler error handling
 * - Removed sourcemap reference
 *
 * Modifications to remote.js:
 * - Only included findFreeTcpPort function (other utilities not needed)
 *
 * Original copyright belongs to Mozilla and contributors.
 * See https://github.com/mozilla/web-ext/blob/master/LICENSE for full license.
 */

const net = require('net');
const EventEmitter = require('events');

const DEFAULT_PORT = 6000;
const DEFAULT_HOST = '127.0.0.1';

// ============================================================================
// Remote Utilities (from src/firefox/remote.js)
// ============================================================================

/**
 * Find an available TCP port on localhost.
 */
function findFreeTcpPort() {
    return new Promise((resolve) => {
        const srv = net.createServer();
        srv.listen(0, '127.0.0.1', () => {
            const addr = srv.address();
            const freeTcpPort = addr && typeof addr === 'object' ? addr.port : 0;
            srv.close(() => resolve(freeTcpPort));
        });
    });
}

// ============================================================================
// RDP Client (from src/firefox/rdp-client.js)
// ============================================================================

/**
 * Parse RDP packets in format: BYTE_LENGTH + ':' + DATA
 */
function parseRDPMessage(data) {
    const str = data.toString();
    const sepIdx = str.indexOf(':');
    if (sepIdx < 1) {
        return { data };
    }
    const byteLen = parseInt(str.slice(0, sepIdx));
    if (isNaN(byteLen)) {
        const error = new Error('Error parsing RDP message length');
        return { data, error, fatal: true };
    }
    if (data.length - (sepIdx + 1) < byteLen) {
        // Can't parse yet, will retry once more data has been received.
        return { data };
    }
    data = data.slice(sepIdx + 1);
    const msg = data.slice(0, byteLen);
    data = data.slice(byteLen);
    try {
        return { data, rdpMessage: JSON.parse(msg.toString()) };
    } catch (error) {
        return { data, error, fatal: false };
    }
}

/**
 * Connect to Firefox and return a connected client
 */
async function connectToFirefox(port) {
    const client = new FirefoxRDPClient();
    await client.connect(port);
    return client;
}

/**
 * Firefox RDP Client - handles communication with Firefox's Remote Debugging Protocol
 */
class FirefoxRDPClient extends EventEmitter {
    constructor() {
        super();
        this._incoming = Buffer.alloc(0);
        this._pending = [];
        this._active = new Map();
        this._rdpConnection = null;
        this._onData = (data) => this.onData(data);
        this._onError = (err) => this.onError(err);
        this._onEnd = () => this.onEnd();
        this._onTimeout = () => this.onTimeout();
    }

    connect(port) {
        return new Promise((resolve, reject) => {
            const conn = net.createConnection({ port, host: DEFAULT_HOST });
            this._rdpConnection = conn;

            conn.on('data', this._onData);
            conn.on('error', this._onError);
            conn.on('end', this._onEnd);
            conn.on('timeout', this._onTimeout);

            // Handle connection errors
            conn.once('error', reject);

            // Resolve once the expected initial root message has been received
            this._expectReply('root', { resolve, reject });
        });
    }

    disconnect() {
        if (!this._rdpConnection) {
            return;
        }
        const conn = this._rdpConnection;
        conn.off('data', this._onData);
        conn.off('error', this._onError);
        conn.off('end', this._onEnd);
        conn.off('timeout', this._onTimeout);
        conn.end();
        this._rdpConnection = null;
        this._rejectAllRequests(new Error('RDP connection closed'));
    }

    _rejectAllRequests(error) {
        for (const activeDeferred of this._active.values()) {
            activeDeferred.reject(error);
        }
        this._active.clear();
        for (const { deferred } of this._pending) {
            deferred.reject(error);
        }
        this._pending = [];
    }

    async request(requestProps) {
        let request;
        if (typeof requestProps === 'string') {
            request = { to: 'root', type: requestProps };
        } else {
            request = requestProps;
        }
        if (request.to == null) {
            throw new Error(`Unexpected RDP request without target actor: ${request.type}`);
        }
        return new Promise((resolve, reject) => {
            const deferred = { resolve, reject };
            this._pending.push({ request, deferred });
            this._flushPendingRequests();
        });
    }

    _flushPendingRequests() {
        this._pending = this._pending.filter(({ request, deferred }) => {
            if (this._active.has(request.to)) {
                // Keep in pending until no active request on this actor
                return true;
            }
            const conn = this._rdpConnection;
            if (!conn) {
                throw new Error('RDP connection closed');
            }
            try {
                let str = JSON.stringify(request);
                str = `${Buffer.from(str).length}:${str}`;
                conn.write(str);
                this._expectReply(request.to, deferred);
            } catch (err) {
                deferred.reject(err);
            }
            return false;
        });
    }

    _expectReply(targetActor, deferred) {
        if (this._active.has(targetActor)) {
            throw new Error(`${targetActor} already has an active request`);
        }
        this._active.set(targetActor, deferred);
    }

    _handleMessage(rdpData) {
        if (rdpData.from == null) {
            if (rdpData.error) {
                this.emit('rdp-error', rdpData);
                return;
            }
            this.emit('error', new Error(`RDP message without sender: ${JSON.stringify(rdpData)}`));
            return;
        }
        // Check if this is a response to an active request
        if (this._active.has(rdpData.from)) {
            const deferred = this._active.get(rdpData.from);
            this._active.delete(rdpData.from);
            if (rdpData.error) {
                deferred?.reject(rdpData);
            } else {
                deferred?.resolve(rdpData);
            }
            this._flushPendingRequests();
            return;
        }
        // All other messages (known event types or unknown) are emitted as unsolicited events
        // This is more permissive than web-ext's original behavior, but necessary for
        // extension debugging where Firefox sends many different message types
        this.emit('unsolicited-event', rdpData);
    }

    _readMessage() {
        const { data, rdpMessage, error, fatal } = parseRDPMessage(this._incoming);
        this._incoming = data;
        if (error) {
            this.emit('error', new Error(`Error parsing RDP packet: ${String(error)}`));
            if (fatal) {
                this.disconnect();
            }
            return !fatal;
        }
        if (!rdpMessage) {
            return false;
        }
        this._handleMessage(rdpMessage);
        return true;
    }

    onData(data) {
        this._incoming = Buffer.concat([this._incoming, data]);
        while (this._readMessage()) {
            // Keep parsing until no more complete messages
        }
    }

    onError(error) {
        this.emit('error', error);
    }

    onEnd() {
        this.emit('end');
    }

    onTimeout() {
        this.emit('timeout');
    }
}

module.exports = { DEFAULT_PORT, DEFAULT_HOST, findFreeTcpPort, parseRDPMessage, connectToFirefox, FirefoxRDPClient };
