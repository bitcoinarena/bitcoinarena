// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// TOR ON LINUX (playtest 2026-10-25: "lnd and Tor fails on Linux, works on macOS"; measured in a fresh ubuntu:24.04 container: the
// release's tor stopped with "error while loading shared libraries: libevent-2.1.so.7"): on Linux tor starts through a launcher that
// puts its own folder on the library path; LND is told to use Tor only once Tor's control port answers, else it runs without it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { torCommand } from '../src/tor.js';
import { setUpOwnLnd } from '../src/lnd-setup.js';
import { nodeState } from '../src/state.js';

test('on Linux tor starts through a launcher with its own libraries; elsewhere tor itself', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'arena-tor-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const cmd = torCommand({ home, tor: '/r/runtime/tor/tor', platform: 'linux' });
  assert.deepEqual(cmd, [join(home, 'tor', 'run-tor.sh'), '/r/runtime/tor/tor']);
  const sh = readFileSync(cmd[0], 'utf8');
  assert.match(sh, /^#!\/bin\/sh\n/);
  assert.match(sh, /LD_LIBRARY_PATH="\$\(dirname "\$TOR"\)\$\{LD_LIBRARY_PATH:\+:\$LD_LIBRARY_PATH\}" exec "\$TOR" "\$@"/, 'tor\'s own folder, from its path: an update that moves tor moves it too');
  assert.equal(statSync(cmd[0]).mode & 0o100, 0o100, 'executable');
  assert.deepEqual(torCommand({ home, tor: '/r/runtime/tor/tor', platform: 'darwin' }), ['/r/runtime/tor/tor']);
});

test('LND gets Tor only once Tor answers; without it LND runs on clearnet and the node says why', async (t) => {
  const run = async (answers) => {
    const home = mkdtempSync(join(tmpdir(), 'arena-lndtor-'));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const state = nodeState(home);
    state.save({ chain: { kind: 'core', url: 'http://127.0.0.1:48332/', cookiePath: join(home, 'cookie') } });
    const programs = [], configured = [];
    const r = await setUpOwnLnd({ state, release: '/r', fetcher: async () => ({}),
      reach: { checkDirect: async () => ({ ok: true, reached: false }) },
      lndKit: { installLnd: async () => ({ ok: true, lnd: '/fake/lnd' }), lndArgs: () => ['/fake/lnd'],
        configureLnd: (o) => { configured.push(o); return { lnddir: join(home, 'lnd'), restUrl: 'https://127.0.0.1:8080', tlsCert: 'c', macaroon: 'm', passwordFile: 'p' }; },
        installProgram: async (o) => { programs.push(o); return { ok: true }; } },
      tor: { torBin: async () => '/r/runtime/tor/tor', writeTorrc: () => join(home, 'tor', 'torrc'), torCommand: ({ tor }) => ['/launcher', tor], torUp: async () => answers } });
    return { r, programs, configured, st: state.read() };
  };
  const up = await run(true);
  assert.equal(up.r.ok, true);
  assert.deepEqual(up.programs[0].args, ['/launcher', '/r/runtime/tor/tor', '-f', up.programs[0].args[3]], 'tor through its launcher');
  assert.ok(up.configured[0].tor, 'Tor answered: LND gets its [Tor] section');
  assert.match(up.r.peers, /Tor gives LND an onion address/);
  const down = await run(false);
  assert.equal(down.r.ok, true, 'LND still set up');
  assert.equal(down.configured[0].tor, null, 'Tor did not answer: LND runs without it');
  assert.match(down.st.tor.why, /Tor did not start \(its control port did not answer within 30 s\): LND runs without it/);
});
