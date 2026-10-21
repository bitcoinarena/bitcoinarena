// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// START / STOP / RESTART AND AT BOOT FROM THE OWNER PAGE (kanban #563): on a running seat, set up by hand and installed. The installed
// node's units are named for an instance no machine runs (ARENA_INSTANCE=t563x, set before anything loads), so the real systemctl this
// test reaches can only find no such unit - the route is checked to hand the right unit to the installer's control, nothing is touched.
process.env.ARENA_INSTANCE = 't563x';
const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
const { join } = await import('node:path');
const { tmpdir } = await import('node:os');
const { schnorr } = await import('@noble/curves/secp256k1.js');
const { ownerSecretFromSeed, signOwnerRequest } = await import('../src/owner.js');
const { toHex } = await import('../../arena-protocol/src/hash.js');
const { serve } = await import('../src/server.js');
const { openStore } = await import('../src/store.js');
const { unitName } = await import('../../arena-installer/src/service.js');

const secret = ownerSecretFromSeed(new Uint8Array(32).fill(7));
const ownerRec = { pubkey: toHex(schnorr.getPublicKey(secret)), claimedAtMs: 1 };
const store = { read: () => ownerRec, write: (o) => Object.assign(ownerRec, o), writeCode: () => {} };
async function seatAt(file, extra = {}) {
  const calls = [];
  let running = true;
  const guardianControl = { has: () => true, running: () => running, stop: async () => { calls.push('stop'); running = false; return { ok: true }; }, start: async () => { calls.push('start'); running = true; return { ok: true }; } };
  const d = await serve(openStore(file), { port: 0, owner: { store }, publicEndpoint: 'ws://127.0.0.1:9/', guardian: { apiPort: 1, p2pPort: 2 }, guardianControl, ...extra });
  const base = `http://127.0.0.1:${d.port}`;
  const node = (await (await fetch(`${base}/owner`)).json()).node;
  const ask = async (path, action, args = {}) => {
    const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(signOwnerRequest({ node, action, args, secret, sign: (m, x) => schnorr.sign(m, x), pubkeyOf: (x) => schnorr.getPublicKey(x) })) });
    return { status: r.status, j: await r.json() };
  };
  const row = async (id) => (await ask('/owner/services', 'services')).j.services.find((x) => x.id === id);
  return { d, ask, row, calls };
}

test('a node set up by hand: its own services started, stopped, restarted and kept off at boot across a restart; what runs outside it refused with the reason', async () => {
  delete process.env.ARENA_HOME;
  const file = join(mkdtempSync(join(tmpdir(), 'svc-manual-')), 'node.db');
  let s = await seatAt(file);
  try {
    assert.deepEqual(await s.row('announcements').then((r) => [r.controls, r.atBoot, r.bootSettable]), [['stop', 'restart'], true, true]);
    assert.deepEqual((await s.row('guardian')).controls, ['stop', 'restart']);
    assert.deepEqual((await s.row('p2p-tunnel')).controls, ['stop', 'restart']);
    const stop = await s.ask('/owner/service', 'service', { id: 'announcements', action: 'stop' });
    assert.deepEqual([stop.status, stop.j.running], [200, false]);
    assert.deepEqual((await s.row('announcements')).controls, ['start']);
    assert.equal((await s.ask('/owner/service', 'service', { id: 'announcements', action: 'start' })).j.running, true);
    assert.equal((await s.ask('/owner/service', 'service', { id: 'p2p-tunnel', action: 'restart' })).j.running, true);
    assert.equal((await s.ask('/owner/service', 'service', { id: 'guardian', action: 'stop' })).j.running, false);
    assert.equal((await s.ask('/owner/service', 'service', { id: 'guardian', action: 'start' })).j.running, true);
    assert.deepEqual(s.calls, ['stop', 'start'], 'the node\'s own guardian control');
    assert.deepEqual((await s.ask('/owner/service', 'service', { id: 'announcements', action: 'boot-off' })).j, { ok: true, id: 'announcements', atBoot: false });
    const chain = await s.ask('/owner/service', 'service', { id: 'chain', action: 'start' });
    assert.equal(chain.status, 409); assert.match(chain.j.why, /set up by hand/);
    const chainBoot = await s.ask('/owner/service', 'service', { id: 'chain', action: 'boot-on' });
    assert.equal(chainBoot.status, 409);
    assert.equal((await s.ask('/owner/service', 'service', { id: 'node', action: 'restart' })).status, 409);
    await s.d.close();
    s = await seatAt(file);                                     // the node restarted: announcements stay off, as the owner set
    const r = await s.row('announcements');
    assert.deepEqual([r.controls, r.atBoot, r.running], [['start'], false, true]);
  } finally { await s.d.close(); }
});

test('an installed node: the installer\'s gateway, tunnel (its address) and Bitcoin Core handed to its service control and boot setting; the seat restart only', async () => {
  const root = mkdtempSync(join(tmpdir(), 'svc-installed-'));
  const was = { home: process.env.ARENA_HOME, xdg: process.env.XDG_CONFIG_HOME };
  const home = join(root, 'home'); mkdirSync(home, { recursive: true });
  const units = join(root, 'config', 'systemd', 'user'); mkdirSync(units, { recursive: true });
  for (const id of ['node', 'gateway', 'tunnel']) writeFileSync(join(units, unitName(id)), '[Service]\nExecStart=/bin/true\n');
  process.env.XDG_CONFIG_HOME = join(root, 'config');
  process.env.ARENA_HOME = home;
  const s = await seatAt(join(home, 'node.db'));
  writeFileSync(join(home, 'arena.conf'), `port=${s.d.port}\nroles=verify\n`);
  writeFileSync(join(home, 'state.json'), '{}');
  try {
    assert.match(unitName('gateway'), /t563x/, 'an instance no machine runs');
    const gw = await s.row('gateway');
    const by = (r) => (r.running === false ? ['start'] : r.running === true ? ['stop', 'restart'] : ['start', 'stop', 'restart']);
    assert.deepEqual([gw.controls, gw.bootSettable], [by(gw), true], 'what applies to its state now');
    const tn = await s.row('tunnel'); assert.deepEqual(tn.controls, by(tn));
    assert.deepEqual((await s.row('node')).controls, ['restart']);
    assert.deepEqual((await s.row('announcements')).controls, ['stop', 'restart'], 'the node\'s own, on an installed node too');
    const stop = await s.ask('/owner/service', 'service', { id: 'gateway', action: 'stop' });
    assert.ok([200, 409].includes(stop.status));
    if (stop.status === 409) assert.match(String(stop.j.why), new RegExp(unitName('gateway').replace('.', '\\.')), 'handed to systemctl as its unit');
    const addr = await s.ask('/owner/service', 'service', { id: 'address', action: 'boot-on' });
    assert.ok(addr.status === 200 || /t563x|not found|No such/i.test(String(addr.j.why)), 'the address is the tunnel\'s unit');
    const seat = await s.ask('/owner/service', 'service', { id: 'node', action: 'stop' });
    assert.deepEqual([seat.status, /restart only/.test(seat.j.why)], [409, true]);
  } finally {
    for (const [k, v] of [['ARENA_HOME', was.home], ['XDG_CONFIG_HOME', was.xdg]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await s.d.close(); rmSync(root, { recursive: true, force: true });
  }
});
