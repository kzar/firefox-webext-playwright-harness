// Unit tests for the RDP port lockfile registry. These don't need a browser — they
// exercise the cross-process reservation primitives directly.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { acquireRdpPort, tryClaimPort, LOCK_DIR } from '../../src/rdp-port.js';

test('acquireRdpPort creates a PID lockfile and release() removes it', async () => {
    const { port, release } = await acquireRdpPort();
    const lockPath = path.join(LOCK_DIR, `${port}.lock`);
    assert.ok(fs.existsSync(lockPath));
    assert.equal(fs.readFileSync(lockPath, 'utf8'), String(process.pid));
    await release();
    assert.ok(!fs.existsSync(lockPath));
    await release(); // idempotent
});

test('a second claim on a held port fails while the first is held', async () => {
    const { port, release } = await acquireRdpPort();
    assert.equal(await tryClaimPort(port), null);
    await release();
    // Once released, the port can be claimed again.
    const third = await tryClaimPort(port);
    assert.ok(third);
    await third();
});

test('a lock owned by a dead process is reclaimed as stale', async () => {
    const { port, release } = await acquireRdpPort();
    await release(); // free our own lock so we control the file
    const lockPath = path.join(LOCK_DIR, `${port}.lock`);
    // Hand-write a lock owned by an impossible PID (far above any real one).
    fs.writeFileSync(lockPath, String(2 ** 30));

    const stolen = await tryClaimPort(port);
    assert.ok(stolen, 'stale lock should be reclaimable');
    assert.equal(fs.readFileSync(lockPath, 'utf8'), String(process.pid));
    await stolen();
});
