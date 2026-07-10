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
 * - Reworked UNSOLICITED_EVENTS into UNSOLICITED_EVENT_TYPES, checked BEFORE response
 *   matching: RDP matches responses to requests by actor only, so an actor's events
 *   (e.g. the watcher's target-available-form, the console's evaluationResult) arriving
 *   while a request to that same actor is in flight would otherwise be consumed as the
 *   request's response. Unknown message types from an actor with an active request are
 *   still treated as that request's response, as upstream does.
 * - Centralised connection teardown in _teardown(): socket end/error and explicit
 *   disconnect() all reject in-flight and pending requests and emit a 'disconnect'
 *   event so waiters can fail fast instead of hanging.
 * - 'error' is only emitted when a listener is attached (_emitError) — an unhandled
 *   EventEmitter 'error' event would crash the process. connect() failures reject the
 *   connect promise (via the pending root handshake) rather than emitting.
 * - Error replies reject their request with an Error (message from the packet's
 *   error/message fields, raw packet kept on err.rdpPacket) instead of the raw packet
 *   object, which stringified to '[object Object]' at catch sites.
 * - A from-less error packet is now surfaced through _emitError (a warning) rather than
 *   a listenerless 'rdp-error' emit that dropped it silently.
 * - Incremental O(n) receive framing: incoming bytes are buffered as a list of chunks
 *   with a running byte count; only the ASCII length header (first <=32 bytes) is
 *   decoded per chunk, and the payload is concatenated/decoded exactly once when the
 *   whole frame has arrived — replacing the previous full-buffer decode+concat on every
 *   TCP chunk (O(n^2) for large results). Two framing errors that upstream buffered
 *   forever are now fatal: a leading ':' (empty length) and no ':' within 32 bytes.
 * - Frame the request length with Buffer.byteLength instead of allocating a throwaway
 *   Buffer just to read .length; still a single conn.write (setNoDelay is deliberate,
 *   so two writes would emit two TCP segments).
 * - Removed dead code: connectToFirefox, DEFAULT_PORT, the never-armed socket 'timeout'
 *   handler (setTimeout is never called), and the listenerless 'end' emit.
 * - Removed domain usage for simpler error handling
 * - Removed sourcemap reference
 * - Disabled Nagle's algorithm on the connection (setNoDelay), as is standard for
 *   debugging protocol transports, so small request packets are never coalesced
 *
 * Modifications to remote.js:
 * - Only included findFreeTcpPort function (other utilities not needed)
 *
 * Original copyright belongs to Mozilla and contributors.
 * See https://github.com/mozilla/web-ext/blob/master/LICENSE for full license.
 */

const net = require('net');
const EventEmitter = require('events');

const DEFAULT_HOST = '127.0.0.1';

// Max bytes to scan for the "<byteLen>:" header before declaring the framing fatal.
// The prefix is a decimal byte count in ASCII, so 32 bytes is far more than any real
// header needs; a stream with no ':' in that window is unrecoverable garbage.
const HEADER_SCAN_LIMIT = 32;

// Message types that are always unsolicited events, never request responses. RDP
// matches responses by actor only, so without this list an event from an actor with an
// in-flight request would be misattributed as that request's response (and the real
// response, arriving next, would leak as a spurious event).
const UNSOLICITED_EVENT_TYPES = new Set([
    'evaluationResult',
    'consoleAPICall',
    'target-available-form',
    'target-destroyed-form',
    'addonListChanged',
    'tabListChanged',
    'networkEvent',
    'networkEventUpdate',
    'tabNavigated',
    'frameUpdate',
    'newSource',
    'resource-available-form',
    'resource-destroyed-form',
    'resources-available-array',
]);

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
 *
 * The FirefoxRDPClient no longer uses this internally (it frames incrementally — see
 * _readMessage), but it is kept exported: the unit tests' scripted RDP server uses it
 * to parse the client's own requests.
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
 * Firefox RDP Client - handles communication with Firefox's Remote Debugging Protocol
 */
class FirefoxRDPClient extends EventEmitter {
    constructor() {
        super();
        // Incoming bytes are buffered as a list of chunks with a running total, so a
        // large frame arriving across many TCP reads is concatenated and decoded once
        // (when complete) rather than re-scanned on every chunk — see _readMessage.
        this._chunks = [];
        this._chunkBytes = 0;
        this._expectedFrame = null;
        this._pending = [];
        this._active = new Map();
        this._rdpConnection = null;
        this._onData = (data) => this.onData(data);
        this._onError = (err) => this.onError(err);
        this._onEnd = () => this.onEnd();
    }

    connect(port) {
        return new Promise((resolve, reject) => {
            const conn = net.createConnection({ port, host: DEFAULT_HOST });
            conn.setNoDelay(true);
            this._rdpConnection = conn;

            conn.on('data', this._onData);
            conn.on('error', this._onError);
            conn.on('end', this._onEnd);

            // Resolve once the expected initial root message has been received. A
            // connection failure (e.g. ECONNREFUSED) rejects this deferred via
            // onError -> _teardown -> _rejectAllRequests.
            this._expectReply('root', { resolve, reject });
        });
    }

    disconnect() {
        this._teardown(new Error('RDP connection closed'));
    }

    /**
     * Tear the connection down (idempotent): close the socket, reject every in-flight
     * and pending request with `error`, and emit 'disconnect' so waiters for
     * unsolicited events (e.g. evaluation results) can fail fast instead of hanging.
     */
    _teardown(error) {
        if (!this._rdpConnection) {
            return;
        }
        const conn = this._rdpConnection;
        this._rdpConnection = null;
        conn.off('data', this._onData);
        conn.off('error', this._onError);
        conn.off('end', this._onEnd);
        conn.destroy();
        this._rejectAllRequests(error);
        this.emit('disconnect', error);
    }

    // Emitting 'error' with no listener attached would crash the process
    // (EventEmitter semantics), so only emit when someone is listening.
    _emitError(error) {
        if (this.listenerCount('error') > 0) {
            this.emit('error', error);
        }
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
                deferred.reject(new Error('RDP connection closed'));
                return false;
            }
            try {
                const str = JSON.stringify(request);
                conn.write(`${Buffer.byteLength(str)}:${str}`);
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
            // A from-less packet is a protocol error (including error packets that name
            // no actor); surface it through _emitError (a warning) rather than dropping
            // it via a listenerless emit.
            this._emitError(new Error(`RDP message without sender: ${JSON.stringify(rdpData)}`));
            return;
        }
        // Known event types are always unsolicited, even when a request to the same
        // actor is in flight — see UNSOLICITED_EVENT_TYPES.
        if (UNSOLICITED_EVENT_TYPES.has(rdpData.type)) {
            this.emit('unsolicited-event', rdpData);
            return;
        }
        // Check if this is a response to an active request
        if (this._active.has(rdpData.from)) {
            const deferred = this._active.get(rdpData.from);
            this._active.delete(rdpData.from);
            if (rdpData.error) {
                // RDP error replies are plain packets ({ from, error: 'code', message }),
                // not Errors — wrap so callers get a usable message instead of
                // '[object Object]', keeping the raw packet on err.rdpPacket.
                const err = new Error(
                    `RDP actor ${rdpData.from} replied with error '${rdpData.error}'` +
                        (rdpData.message ? `: ${rdpData.message}` : ''),
                );
                err.rdpPacket = rdpData;
                deferred?.reject(err);
            } else {
                deferred?.resolve(rdpData);
            }
            this._flushPendingRequests();
            return;
        }
        // Other messages (unknown event types with no active request) are also
        // emitted as unsolicited events. This is more permissive than web-ext's
        // original behavior, but necessary for extension debugging where Firefox
        // sends many different message types.
        this.emit('unsolicited-event', rdpData);
    }

    // Return a Buffer of up to `n` leading bytes of the buffered input. When the first
    // chunk already holds enough this is a cheap subarray; only pathologically small
    // chunks (during header scanning) force a one-off compaction.
    _peekHead(n) {
        if (this._chunks.length === 0) {
            return Buffer.alloc(0);
        }
        if (this._chunks[0].length >= n || this._chunks.length === 1) {
            return this._chunks[0].subarray(0, n);
        }
        const merged = Buffer.concat(this._chunks);
        this._chunks = [merged];
        return merged.subarray(0, n);
    }

    _failFraming() {
        // Message text kept byte-identical with the previous parseRDPMessage-based path
        // (a standalone test pins the teardown message shape).
        const lengthError = new Error('Error parsing RDP message length');
        this._emitError(new Error(`Error parsing RDP packet: ${String(lengthError)}`));
        this._teardown(new Error(`RDP connection closed: unparseable packet (${String(lengthError)})`));
    }

    _readMessage() {
        if (this._chunkBytes === 0) {
            return false;
        }

        // Header phase: locate the ASCII "<byteLen>:" prefix without decoding the payload.
        if (this._expectedFrame === null) {
            const head = this._peekHead(HEADER_SCAN_LIMIT);
            const sepIdx = head.indexOf(0x3a); // ':'
            if (sepIdx < 1) {
                // A leading ':' (empty length) can never become valid → fatal. Otherwise
                // wait for more bytes, unless we've already buffered enough that a header
                // can no longer be coming (unrecoverable garbage) → fatal.
                if (sepIdx === 0 || this._chunkBytes >= HEADER_SCAN_LIMIT) {
                    this._failFraming();
                }
                return false;
            }
            const byteLen = parseInt(head.toString('latin1', 0, sepIdx), 10);
            if (isNaN(byteLen)) {
                this._failFraming();
                return false;
            }
            this._expectedFrame = { headerLen: sepIdx + 1, byteLen };
        }

        // Body phase: wait until the whole frame has arrived, then concat/slice once.
        const { headerLen, byteLen } = this._expectedFrame;
        if (this._chunkBytes < headerLen + byteLen) {
            return false;
        }
        const buffer = this._chunks.length === 1 ? this._chunks[0] : Buffer.concat(this._chunks);
        const payload = buffer.subarray(headerLen, headerLen + byteLen);
        const remainder = buffer.subarray(headerLen + byteLen);
        this._chunks = remainder.length ? [remainder] : [];
        this._chunkBytes = remainder.length;
        this._expectedFrame = null;

        let rdpMessage;
        try {
            rdpMessage = JSON.parse(payload.toString());
        } catch (error) {
            // A JSON parse error drops just this message (non-fatal), as upstream does.
            this._emitError(new Error(`Error parsing RDP packet: ${String(error)}`));
            return true;
        }
        this._handleMessage(rdpMessage);
        return true;
    }

    onData(data) {
        this._chunks.push(data);
        this._chunkBytes += data.length;
        while (this._readMessage()) {
            // Keep parsing until no more complete messages
        }
    }

    onError(error) {
        this._teardown(error instanceof Error ? error : new Error(`RDP connection error: ${String(error)}`));
        this._emitError(error);
    }

    onEnd() {
        this._teardown(new Error('RDP connection closed by Firefox (socket end)'));
    }
}

module.exports = { findFreeTcpPort, parseRDPMessage, FirefoxRDPClient };
