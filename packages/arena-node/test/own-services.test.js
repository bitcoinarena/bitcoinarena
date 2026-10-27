// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// EVERY SERVICE, ON EVERY NODE (kanban #563, 2026-10-21: "563 must contain all services even if it's custom installed"): the
// seat's own view of what it runs and reaches, each probed - for a node set up by hand as much as for an installed one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownServices } from '../src/own-services.js';

const me = 'ab'.repeat(32);
const byId = (rows) => Object.fromEntries(rows.map((r) => [r.id, r]));

test('a node set up by hand, all up: the seat, the chain at its block, the guardian\'s API, the gateway, its public address from outside, the tunnel, its announcement', async () => {
  const rows = byId(await ownServices({ port: 6511, chainTip: async () => 157190, guardian: { apiPort: 7511, endpoint: 'ws://198.51.100.7:6511/guardian' }, gatewayPort: 6476,
    publicEndpoint: 'ws://198.51.100.7:6511', p2pTunnels: { state: () => [{ state: 'listening' }, { state: 'shared' }] },
    addressBook: { list: () => [{ node: me, endpoint: 'ws://198.51.100.7:6511', atMs: 1000 }] }, ownKey: me,
    fetcher: async (u) => ({ ok: u === 'http://198.51.100.7:6511/identity', status: 200 }), tcp: async () => true, nowMs: () => 1000 + 3 * 60000,
    guardianCheck: async ({ apiPort }) => ({ ok: true, ours: true, says: `its API answers on port ${apiPort}` }) }));
  assert.deepEqual(Object.keys(rows), ['node', 'chain', 'guardian', 'gateway', 'address', 'p2p-tunnel', 'announcements']);
  assert.equal(rows.chain.probe.says, 'at block 157,190');
  assert.deepEqual([rows.guardian.running, rows.guardian.inside], [true, true]);
  assert.match(rows.address.probe.says, /reached at ws:\/\/100\.85\.86\.106:6511/);
  assert.equal(rows['p2p-tunnel'].detail, '2 of 2 guardian port(s) carried');
  assert.match(rows.announcements.probe.says, /announced 3 min ago/);
  assert.ok(Object.values(rows).every((r) => !r.probe || r.probe.ok));
});

test('what is down says so: the chain, the guardian\'s API, the gateway, the public address, an announcement not out yet', async () => {
  const rows = byId(await ownServices({ port: 6511, chainTip: async () => { throw new Error('ECONNREFUSED'); }, guardian: { apiPort: 7511 }, gatewayPort: 6476,
    publicEndpoint: 'https://gone.trycloudflare.com', addressBook: { list: () => [] }, ownKey: me,
    fetcher: async () => { throw new Error('ENOTFOUND'); }, tcp: async () => false, guardianCheck: async ({ apiPort }) => ({ ok: false, ours: null, says: `nothing listens on its API port ${apiPort}` }) }));
  assert.deepEqual([rows.chain.running, rows.chain.probe.ok], [false, false]); assert.match(rows.chain.probe.says, /ECONNREFUSED/);
  assert.match(rows.guardian.probe.says, /nothing listens on its API port 7511/);
  assert.equal(rows.guardian.detail, 'Not running');
  assert.equal(rows.gateway.probe.ok, false);
  assert.match(rows.address.probe.says, /not reached: ENOTFOUND/);
  assert.match(rows.announcements.probe.says, /not announced yet/);
});

test('no guardian, no public address: said, not counted as a fault', async () => {
  const rows = byId(await ownServices({ port: 6511, chainTip: async () => 1, fetcher: async () => ({ ok: true }), tcp: async () => true }));
  assert.equal(rows.guardian.detail, 'this node runs no guardian'); assert.equal(rows.guardian.probe, null);
  assert.match(rows.address.detail, /none set/); assert.equal(rows.address.probe, null);
  assert.equal(rows.gateway, undefined, 'no gateway configured: no row');
});

test('another node\'s guardian on this node\'s API port (the 2026.1.9.11 install test): Not running, with its log\'s reason - never "its API answers"', async () => {
  const seen = [];
  const rows = byId(await ownServices({ port: 11770, chainTip: async () => 1, guardian: { apiPort: 12770, dataDir: '/n/home/node.db.guardian', setup: true },
    fetcher: async () => ({ ok: true }), tcp: async () => true,
    guardianCheck: async (a) => { seen.push(a); return { ok: false, ours: false, says: 'another guardian answers on its API port 12770 and refuses this node\'s password; its log: Bind address: 127.0.0.1:12770 Address already in use' }; } }));
  assert.deepEqual(seen, [{ apiPort: 12770, dataDir: '/n/home/node.db.guardian' }], 'asked on its own port with its own data dir');
  assert.deepEqual([rows.guardian.running, rows.guardian.detail, rows.guardian.probe.ok], [false, 'Not running', false]);
  assert.match(rows.guardian.probe.says, /another guardian answers.*Address already in use/);
});
