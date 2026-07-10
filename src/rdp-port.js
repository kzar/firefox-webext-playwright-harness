/**
 * Cross-process RDP port reservation.
 *
 * findFreeTcpPort() probes a port by binding :0, reading it back and closing the socket
 * — but Firefox only binds the port seconds later (via -start-debugger-server). Under
 * parallel Playwright workers, two probes can hand out the same just-freed port during
 * that window, and the loser then silently connects to the winner's Firefox over RDP
 * (RDP gives no way to tell whose browser it reached), installing its extensions into
 * the wrong browser. A tiny lockfile registry in the temp dir closes that window: a port
 * isn't handed out until this process has exclusively claimed its lock, held until the
 * Firefox instance it belongs to is torn down.
 */

const fs = require('fs/promises');
const fsSync = require('fs');
const os = require('os');
const path = require('path');
const { findFreeTcpPort } = require('./web-ext-rdp.js');

const LOCK_DIR = path.join(os.tmpdir(), 'fx-harness-rdp-port-locks');

// Locks this process currently holds, swept by the exit hook below so a killed worker
// (e.g. Playwright teardown timeout) can't strand a port for the rest of the run.
const _heldLocks = new Set();
process.on('exit', () => {
    for (const lockPath of _heldLocks) {
        try {
            fsSync.rmSync(lockPath, { force: true });
        } catch {
            // Best-effort cleanup
        }
    }
});

function lockPathFor(port) {
    return path.join(LOCK_DIR, `${port}.lock`);
}

// Is the PID that wrote a lockfile still alive? Signal 0 checks for existence without
// actually signalling: ESRCH means the process is gone, EPERM means it's alive but owned
// by another user.
function isPidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return e.code === 'EPERM';
    }
}

/**
 * Try to exclusively claim `port`'s lockfile. Resolves with an idempotent release()
 * on success, or null if the port is locked by a live process. A lock left behind by a
 * dead process is reclaimed. Exported for unit tests.
 */
async function tryClaimPort(port) {
    const lockPath = lockPathFor(port);
    try {
        // 'wx' fails if the file exists — an atomic exclusive create.
        await fs.writeFile(lockPath, String(process.pid), { flag: 'wx' });
    } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        // Someone holds it. If that owner is dead, steal the stale lock; else back off.
        let ownerPid = NaN;
        try {
            ownerPid = parseInt(await fs.readFile(lockPath, 'utf8'), 10);
        } catch {
            // Lock vanished between the failed create and this read — treat as stale.
        }
        if (isPidAlive(ownerPid)) {
            return null;
        }
        try {
            await fs.rm(lockPath, { force: true });
            await fs.writeFile(lockPath, String(process.pid), { flag: 'wx' });
        } catch {
            // Lost a race to reclaim it — let the caller pick another port.
            return null;
        }
    }
    _heldLocks.add(lockPath);
    let released = false;
    return async () => {
        if (released) return;
        released = true;
        _heldLocks.delete(lockPath);
        await fs.rm(lockPath, { force: true });
    };
}

/**
 * Find a free TCP port and exclusively reserve it for this process until release() is
 * called (or the process exits). See the module comment for why the reservation matters.
 * @param {object} [options]
 * @param {number} [options.maxAttempts=10]
 * @returns {Promise<{ port: number, release: () => Promise<void> }>}
 */
async function acquireRdpPort({ maxAttempts = 10 } = {}) {
    await fs.mkdir(LOCK_DIR, { recursive: true });
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const port = await findFreeTcpPort();
        const release = await tryClaimPort(port);
        if (release) {
            return { port, release };
        }
    }
    throw new Error(`Could not reserve a free RDP port after ${maxAttempts} attempts`);
}

module.exports = { acquireRdpPort, tryClaimPort, LOCK_DIR };
