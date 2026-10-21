// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A GUARDIAN THAT OUTLIVES ITS NODE (2026-10-03, "2. Separate guardian and node"): with ARENA_GUARDIAN_KEEP=1 the
// node starts its own guardian - nothing typed - as a systemd user unit of its own, adopts that unit when it already
// runs, and leaves it running when the node closes. Without the setting nothing changes (guardian.test.js) - except a guardian
// waiting in setup (`keep`, kanban #495): fedimintd detached with a pidfile, on every system, adopted by the next start.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startGuardian, guardianUnit, pidfileUnits } from '../src/guardian.js';

const TS = {
  status: { Self: { DNSName: 'seat.example.com.' } },
  funnel: {
    AllowFunnel: { 'seat.example.com:443': true },
    Web: { 'seat.example.com:443': { Handlers: {
      '/': { Proxy: 'http://localhost:3001' },
      '/blwp-a': { Proxy: 'http://198.51.100.7:18080' },
      '/guardian-1': { Proxy: 'http://127.0.0.1:31221' },
      '/guardian-2': { Proxy: 'http://127.0.0.1:31231' } } } },
  },
};
const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), 'guardian-keep-'));
  const cookie = join(dir, '.cookie'); writeFileSync(cookie, '__cookie__:sekrit');
  const bin = join(dir, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'fedimintd'), '#!/bin/sh\nexec sleep 60\n'); chmodSync(join(bin, 'fedimintd'), 0o755);
  return { dir, cookie, bin, call: async () => ({ chain: 'testnet4' }) };
};
const fakeUnits = (running) => {
  const started = [];
  return { started, active: async (u) => running.has(u), start: async (u, b, env, log) => { started.push({ u, b, env, log }); running.add(u); } };
};

test('kept: the node starts its guardian as its own unit with the derived environment, and closing the node stops nothing', async () => {
  const { dir, cookie, bin, call } = setup();
  const units = fakeUnits(new Set());
  const g = await startGuardian({ nodePort: 31221, host: '127.0.0.1', storePath: join(dir, 'a.db'), bitcoindUrl: 'http://127.0.0.1:48332',
    cookiePath: cookie, call, env: { PATH: `${bin}:/usr/bin:/bin`, ARENA_GUARDIAN_KEEP: '1' }, tailscale: TS, log: () => {}, units });
  assert.equal(g.running, true); assert.equal(g.kept, true); assert.equal(g.adopted, false);
  assert.equal(units.started.length, 1);
  const s = units.started[0];
  assert.equal(s.u, guardianUnit(31221)); assert.equal(s.u, 'blwp-tn4-guardian-31221');
  assert.equal(s.b, join(bin, 'fedimintd'));
  assert.equal(s.env.FM_API_URL, 'wss://seat.example.com/guardian-1/guardian');
  assert.equal(s.env.FM_DATA_DIR, join(dir, 'a.db.guardian'));
  assert.equal(s.env.FM_BITCOIND_PASSWORD, 'sekrit');
  assert.equal(s.log, join(dir, 'a.db.guardian', 'fedimintd.log'));
  assert.ok(existsSync(join(dir, 'a.db.guardian', 'admin-password')));
  await g.stop();
  assert.equal(units.started.length, 1, 'closing the node started or stopped nothing');
});

test('kept: a node that starts while its guardian unit runs adopts it and does not restart it', async () => {
  const { dir, cookie, bin, call } = setup();
  const units = fakeUnits(new Set([guardianUnit(31231)]));
  const g = await startGuardian({ nodePort: 31231, host: '127.0.0.1', storePath: join(dir, 'b.db'), bitcoindUrl: 'http://127.0.0.1:48332',
    cookiePath: cookie, call, env: { PATH: `${bin}:/usr/bin:/bin`, ARENA_GUARDIAN_KEEP: '1' }, tailscale: TS, log: () => {}, units });
  assert.equal(g.running, true); assert.equal(g.adopted, true);
  assert.equal(units.started.length, 0, 'the running guardian was not started again');
  assert.equal(g.endpoint, 'wss://seat.example.com/guardian-2/guardian');
});

const fakePids = (runningPid = null) => {
  const calls = { started: [], stopped: 0 };
  let pid = runningPid;
  return { calls, pid: () => pid, active: async () => pid !== null,
    start: async (dataDir, bin, env, log) => { calls.started.push({ dataDir, bin, env, log }); pid = 4242; return pid; },
    stop: async () => { calls.stopped++; pid = null; } };
};

test('a guardian waiting in setup is kept without systemd: started detached, closing the node stops nothing, halt stops it (kanban #495)', async () => {
  const { dir, cookie, bin, call } = setup();
  const pids = fakePids();
  const g = await startGuardian({ nodePort: 6521, host: '127.0.0.1', storePath: join(dir, 'c.db'), bitcoindUrl: 'http://127.0.0.1:48332',
    cookiePath: cookie, call, env: { PATH: `${bin}:/usr/bin:/bin` }, tailscale: TS, log: () => {}, keep: true, pids });
  assert.equal(g.running, true); assert.equal(g.kept, true); assert.equal(g.adopted, false); assert.equal(g.pid, 4242);
  assert.equal(pids.calls.started.length, 1);
  assert.equal(pids.calls.started[0].dataDir, join(dir, 'c.db.guardian'));
  assert.equal(pids.calls.started[0].env.FM_DATA_DIR, join(dir, 'c.db.guardian'));
  await g.stop();
  assert.equal(pids.calls.stopped, 0, 'the node closing leaves its setup guardian running');
  await g.halt();
  assert.equal(pids.calls.stopped, 1, 'halt stops it (a fresh setup, the owner page)');
});

test('a node that starts while its kept guardian runs adopts it - in setup or keyed - and starts no second fedimintd', async () => {
  const { dir, cookie, bin, call } = setup();
  for (const keep of [true, false]) {
    const pids = fakePids(5151);
    const g = await startGuardian({ nodePort: 6531, host: '127.0.0.1', storePath: join(dir, `d${keep}.db`), bitcoindUrl: 'http://127.0.0.1:48332',
      cookiePath: cookie, call, env: { PATH: `${bin}:/usr/bin:/bin` }, tailscale: TS, log: () => {}, keep, pids });
    assert.equal(g.adopted, true); assert.equal(g.pid, 5151);
    assert.equal(pids.calls.started.length, 0);
  }
});

test('pidfileUnits: a detached fedimintd outlives the call, is seen by its pidfile, and stops; a pidfile naming another program is no guardian', async () => {
  const { dir } = setup();
  const data = join(dir, 'e.db.guardian'); mkdirSync(data);
  // a stand-in that stays a process named fedimintd (no exec) and ends on TERM
  const own = join(dir, 'own'); mkdirSync(own);
  writeFileSync(join(own, 'fedimintd'), "#!/bin/sh\ntrap 'exit 0' TERM\nwhile :; do sleep 1; done\n"); chmodSync(join(own, 'fedimintd'), 0o755);
  const units = pidfileUnits();
  assert.equal(await units.active(data), false);
  const pid = await units.start(data, join(own, 'fedimintd'), { PATH: '/usr/bin:/bin' }, join(data, 'fedimintd.log'));
  assert.ok(pid > 0);
  assert.equal(await units.active(data), true);
  await units.stop(data);
  assert.equal(await units.active(data), false);
  assert.equal(existsSync(join(data, 'fedimintd.pid')), false);
  writeFileSync(join(data, 'fedimintd.pid'), String(process.pid));     // this test's own pid: alive, but not fedimintd
  assert.equal(await units.active(data), false);
});
