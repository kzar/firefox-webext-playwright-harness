// Unit tests for buildFirefoxLaunchOptions — a pure function, so no browser is launched.
// Pins the two hard rejections (executablePath/channel can't be honoured) and that the
// harness's required prefs win over consumer-supplied firefoxUserPrefs.

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildFirefoxLaunchOptions } from '../../src/harness.js';

test('rejects launchOptions.executablePath (the harness must run its patched Firefox)', () => {
    assert.throws(
        () => buildFirefoxLaunchOptions(1234, { launchOptions: { executablePath: '/custom/firefox' } }),
        /can't honour launchOptions\.executablePath/,
    );
});

test('rejects launchOptions.channel', () => {
    assert.throws(
        () => buildFirefoxLaunchOptions(1234, { launchOptions: { channel: 'firefox-beta' } }),
        /can't honour launchOptions\.channel/,
    );
});

test('HARNESS_REQUIRED_PREFS win over consumer firefoxUserPrefs', () => {
    const opts = buildFirefoxLaunchOptions(1234, {
        launchOptions: {
            firefoxUserPrefs: {
                'devtools.debugger.remote-enabled': false, // consumer attempts to clobber a required pref
                'my.custom.pref': 'kept',
            },
        },
    });
    // Required pref wins the merge; the debugger must stay enabled or the harness can't connect.
    assert.equal(opts.firefoxUserPrefs['devtools.debugger.remote-enabled'], true);
    // Consumer prefs the harness doesn't reserve still apply.
    assert.equal(opts.firefoxUserPrefs['my.custom.pref'], 'kept');
    assert.ok(opts.args.includes('-start-debugger-server=1234'));
});
