// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OWNER AREA'S SERVICES CARD (2026-10-19: "Also have a service overview in the owners area with the status of all
// services"): the owner signs it, the seat answers its installed node's services from the node's home (ARENA_HOME, set by src/run.js
// from arena.conf) without a local path in it; another key is refused; a seat not started from arena.conf says so.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { schnorr } from '@noble/curves/secp256k1.js';
import { ownerSecretFromSeed, signOwnerRequest } from '../src/owner.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { joinedWithLock } from './lock-fixture.js';

test('on a running seat: the owner\'s signed ask answers every service of the node, no local paths; another key refused', async () => {
  const secret = ownerSecretFromSeed(new Uint8Array(32).fill(7));
  const ownerRec = { pubkey: toHex(schnorr.getPublicKey(secret)), claimedAtMs: 1 };
  const store = { read: () => ownerRec, write: (o) => Object.assign(ownerRec, o), writeCode: () => {} };
  const root = mkdtempSync(join(tmpdir(), 'owner-services-'));
  const was = { home: process.env.ARENA_HOME, xdg: process.env.XDG_CONFIG_HOME };
  const s = await joinedWithLock({ owner: { store } });
  try {
    const base = `http://127.0.0.1:${s.d.port}`;
    const node = (await (await fetch(`${base}/owner`)).json()).node;
    const req = (k) => signOwnerRequest({ node, action: 'services', args: {}, secret: k, sign: (m, x) => schnorr.sign(m, x), pubkeyOf: (x) => schnorr.getPublicKey(x) });
    const post = (body) => fetch(`${base}/owner/services`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    delete process.env.ARENA_HOME;
    // A NODE SET UP BY HAND (kanban #563: "all services even if it's custom installed"): its own services, from the seat itself
    const none = await post(req(secret));
    assert.equal(none.status, 200);
    const manual = await none.json();
    assert.deepEqual([manual.manual, manual.command], [true, null]);
    assert.deepEqual(manual.services.slice(0, 2).map((x) => x.id), ['node', 'chain']);
    // an installed node: its arena.conf and the seat's unit (the unit's state is asked of systemctl, which this machine may not have)
    const home = join(root, 'home'); mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'arena.conf'), `port=${s.d.port}\nroles=verify\n`);
    writeFileSync(join(home, 'state.json'), '{}');
    process.env.XDG_CONFIG_HOME = join(root, 'config');
    mkdirSync(join(root, 'config', 'systemd', 'user'), { recursive: true });
    writeFileSync(join(root, 'config', 'systemd', 'user', 'arena-node.service'), '[Service]\n');
    process.env.ARENA_HOME = home;
    assert.equal((await post(req(ownerSecretFromSeed(new Uint8Array(32).fill(9))))).status, 403, 'another key: refused');
    const r = await post(req(secret));
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.deepEqual([j.ok, j.port, j.roles, j.settings, j.command], [true, s.d.port, 'verify', 'arena.conf', 'bitcoinarena']);
    assert.deepEqual(j.services[0].id, 'node'); assert.equal(j.services[0].title, 'Bitcoin Arena node (seat)');
    assert.ok(j.services.some((x) => x.id === 'address'), 'beside the installer\'s: the seat\'s own rows it does not know');
    assert.equal(typeof j.services[0].running, 'boolean');
    assert.ok(!JSON.stringify(j).includes(root), 'no local paths in the answer');
    // A CUSTODY NODE WHOSE SETUP LEFT LIGHTNING FOR LATER (kanban #711, 2026-10-26: "lightning gateway reports error and no hint about
    // reason or how to solve it"): its gateway row says why and offers to set it up, not "does not answer" / "runs outside the node"
    writeFileSync(join(home, 'state.json'), JSON.stringify({ roles: ['verify', 'custody'], chain: { kind: 'core', url: 'http://127.0.0.1:1/' } }));
    process.env.ARENA_GATEWAY_PORT = '1';
    const g = (await (await post(req(secret))).json()).services.find((x) => x.id === 'gateway');
    assert.deepEqual([g.running, g.probe.says, g.fix, g.why], [false, 'Not set up: Lightning was left for later in setup, so the gateway was never started.',
      { action: 'gateway/setup', label: 'Set up the gateway', busy: false }, null]);
    const setupReq = (args) => signOwnerRequest({ node, action: 'gateway/setup', args, secret, sign: (m, x) => schnorr.sign(m, x), pubkeyOf: (x) => schnorr.getPublicKey(x) });
    const p = await fetch(`${base}/owner/gateway/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(setupReq({ progress: true })) });
    assert.deepEqual([p.status, (await p.json()).progress], [200, null], 'nothing started yet: no progress');
    // set up: nothing to say about it
    writeFileSync(join(home, 'state.json'), JSON.stringify({ roles: ['verify', 'custody'], chain: { kind: 'core', url: 'x' }, gateway: { apiUrl: 'http://127.0.0.1:1' } }));
    const g2 = (await (await post(req(secret))).json()).services.find((x) => x.id === 'gateway');
    assert.equal(g2.fix, undefined);
  } finally {
    delete process.env.ARENA_GATEWAY_PORT;
    for (const [k, v] of [['ARENA_HOME', was.home], ['XDG_CONFIG_HOME', was.xdg]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await s.d.close(); rmSync(root, { recursive: true, force: true });
  }
});
