// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A GUARDIAN THAT OUTLIVES ITS NODE (2026-10-03, "2. Separate guardian and node"): with ARENA_GUARDIAN_KEEP=1 the
// node starts its own guardian - nothing typed - as a systemd user unit of its own, adopts that unit when it already
// runs, and leaves it running when the node closes. Without the setting nothing changes (guardian.test.js) - except a guardian
// waiting in setup (`keep`, kanban #495): fedimintd detached with a pidfile, on every system, adopted by the next start.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startGuardian, guardianUnit, pidfileUnits } from '../src/guardian.js';

const TS = {
  status: { Self: { DNSName: 'seat.example.com.' } },
  funnel: {
    AllowFunnel: { 'seat.example.com:443': true },
    Web: { 'seat.example.com:443': { Handlers: {
      '/': { Proxy: 'http://localhost:3001' },
      '/blwp-a': { Proxy: 'http://198.51.100.98:18080' },
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

// kanban #577 (2026-10-23): bitcoind restarted and wrote a new cookie; fedimintd keeps the secret it was started with, and a running guardian
// was adopted on every node restart - an hour without bitcoin RPC. Its cookie's fingerprint is kept beside its data and compared on adoption.
test('a running guardian started on an old bitcoind cookie is started again on adoption; on the same cookie it is adopted', async () => {
  const { dir, cookie, bin, call } = setup();
  const store = join(dir, 'f.db');
  const first = fakePids();
  const g1 = await startGuardian({ nodePort: 6541, host: '127.0.0.1', storePath: store, bitcoindUrl: 'http://127.0.0.1:48332',
    cookiePath: cookie, call, env: { PATH: `${bin}:/usr/bin:/bin` }, tailscale: TS, log: () => {}, keep: true, pids: first });
  assert.equal(first.calls.started.length, 1);
  assert.match(g1.cookieSha, /^[0-9a-f]{64}$/);
  assert.ok(!require_secret(join(dir, 'f.db.guardian', 'bitcoind-cookie.sha')), 'the fingerprint file holds no secret');
  // the same cookie: adopted, nothing started
  const same = fakePids(5161);
  const g2 = await startGuardian({ nodePort: 6541, host: '127.0.0.1', storePath: store, bitcoindUrl: 'http://127.0.0.1:48332',
    cookiePath: cookie, call, env: { PATH: `${bin}:/usr/bin:/bin` }, tailscale: TS, log: () => {}, keep: false, pids: same });
  assert.equal(g2.adopted, true); assert.equal(same.calls.started.length, 0); assert.equal(same.calls.stopped, 0);
  // bitcoind restarted: a new cookie - the running guardian is stopped and started again with the new secret
  writeFileSync(cookie, '__cookie__:fresh');
  const lines = [];
  const after = fakePids(5161);
  const g3 = await startGuardian({ nodePort: 6541, host: '127.0.0.1', storePath: store, bitcoindUrl: 'http://127.0.0.1:48332',
    cookiePath: cookie, call, env: { PATH: `${bin}:/usr/bin:/bin` }, tailscale: TS, log: (l) => lines.push(l), keep: false, pids: after });
  assert.equal(after.calls.stopped, 1, 'the guardian on the old cookie was stopped');
  assert.equal(after.calls.started.length, 1, 'and started again');
  assert.equal(after.calls.started[0].env.FM_BITCOIND_PASSWORD, 'fresh');
  assert.equal(g3.adopted, false); assert.notEqual(g3.cookieSha, g1.cookieSha);
  assert.ok(lines.some((l) => /old bitcoind cookie/.test(l)));
});
const require_secret = (file) => { try { return /sekrit|fresh/.test(String(readFileSync(file))); } catch { return false; } };

// kanban #577 (2026-10-26): a guardian started before its seat carried its peers' API keeps the old addresses while it is adopted;
// the overrides are in the fingerprint, so it is started again once, with them
test('a running guardian whose federation config names peers is started again once with its peers\' API overrides, then adopted', async () => {
  const { dir, cookie, bin, call } = setup();
  const store = join(dir, 'g.db');
  const run = (pids, log = () => {}, keep = false) => startGuardian({ nodePort: 6551, host: '127.0.0.1', storePath: store, bitcoindUrl: 'http://127.0.0.1:48332',
    cookiePath: cookie, call, env: { PATH: `${bin}:/usr/bin:/bin` }, tailscale: TS, log, keep, pids, nodeKey: 'cc'.repeat(32) });
  const first = fakePids();
  await run(first, () => {}, true);                                              // no federation yet: no overrides
  assert.equal(first.calls.started[0].env.FM_WS_API_CONNECT_OVERRIDES, undefined);
  writeFileSync(join(store + '.guardian', 'client.json'), JSON.stringify({ global: { api_endpoints: {
    0: { url: 'wss://gone.trycloudflare.com/guardian', name: 'aaaaaaaaaaaaaaaa' }, 1: { url: 'ws://198.51.100.106:6571/guardian', name: 'cccccccccccccccc' } } } }));
  const lines = [];
  const again = fakePids(5161);
  const g1 = await run(again, (l) => lines.push(l));             // the DKG wrote its config: started again, with them
  // and the running guardian answers the COOKIE's fingerprint, the one node-start.js compares every 30 s (2026-10-26 07:4xZ: it answered
  // the kept one, cookie and overrides, the two never matched, and the guardian was started again every 30 s)
  const { cookieFingerprint } = await import('../src/guardian.js');
  assert.equal(g1.cookieSha, cookieFingerprint(cookie));
  assert.equal(again.calls.stopped, 1); assert.equal(again.calls.started.length, 1);
  const ov = again.calls.started[0].env.FM_WS_API_CONNECT_OVERRIDES;
  assert.match(ov, /wss:\/\/gone\.trycloudflare\.com\/guardian=ws:\/\/127\.0\.0\.1:6551\/guardian-api\/aaaaaaaaaaaaaaaa/);
  assert.match(ov, /ws:\/\/198\.51\.100\.106:6571\/guardian=ws:\/\/127\.0\.0\.1:7551\//, 'its own: its local API port');
  assert.ok(lines.some((l) => /old peer addresses/.test(l)));
  const then = fakePids(5161);
  const g = await run(then);                                     // the same overrides: adopted
  assert.equal(g.adopted, true); assert.equal(then.calls.started.length, 0);
});

// THE DASHBOARD'S PORT, FREE (kanban #326: another program held a T2 guardian's dashboard port and fedimintd exited at start)
test('the dashboard port: the slot\'s when free, the next free one when taken', async () => {
  const { freeLocalPort } = await import('../src/guardian.js');
  const { createServer } = await import('node:net');
  const busy = createServer(); await new Promise((ok) => busy.listen(0, '127.0.0.1', ok));
  const taken = busy.address().port;
  assert.notEqual(await freeLocalPort(taken, { step: 1, tries: 5 }), taken, 'a taken port is passed by');
  busy.close();
  await new Promise((ok) => setTimeout(ok, 50));
  assert.equal(await freeLocalPort(taken, { step: 1, tries: 5 }), taken, 'a free port is kept');
});

// kanban #577 (2026-10-29): fedimintd exits by itself on "Consensus session timed out"; node-start.js starts an exited guardian again by
// asking `alive` every 30 s - a spawned one, a kept one (pidfile) and a unit each answer it
test('a guardian answers whether its process still runs: spawned, kept by pidfile, or a unit', async () => {
  const { dir, cookie, bin, call } = setup();
  writeFileSync(join(bin, 'fedimintd'), '#!/bin/sh\nexit 3\n'); chmodSync(join(bin, 'fedimintd'), 0o755);
  const g = await startGuardian({ nodePort: 6531, host: '127.0.0.1', storePath: join(dir, 'd.db'), bitcoindUrl: 'http://127.0.0.1:48332',
    cookiePath: cookie, call, env: { PATH: `${bin}:/usr/bin:/bin` }, tailscale: TS, log: () => {}, pids: fakePids() });
  assert.equal(g.running, true);
  for (let i = 0; i < 50 && g.alive(); i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(g.alive(), false, 'the spawned fedimintd that exited is not alive');
  const pids = fakePids();
  const k = await startGuardian({ nodePort: 6541, host: '127.0.0.1', storePath: join(dir, 'e.db'), bitcoindUrl: 'http://127.0.0.1:48332',
    cookiePath: cookie, call, env: { PATH: `${bin}:/usr/bin:/bin` }, tailscale: TS, log: () => {}, keep: true, pids });
  assert.equal(await k.alive(), true);
  await k.halt();
  assert.equal(await k.alive(), false, 'a kept one whose pidfile process is gone');
  const running = new Set();
  const u = await startGuardian({ nodePort: 6551, host: '127.0.0.1', storePath: join(dir, 'f.db'), bitcoindUrl: 'http://127.0.0.1:48332',
    cookiePath: cookie, call, env: { PATH: `${bin}:/usr/bin:/bin`, ARENA_GUARDIAN_KEEP: '1' }, tailscale: TS, log: () => {}, units: fakeUnits(running) });
  assert.equal(await u.alive(), true);
  running.clear();
  assert.equal(await u.alive(), false, 'a unit no longer active');
});
