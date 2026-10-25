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
    fetcher: async (u) => ({ ok: u === 'http://198.51.100.7:6511/identity', status: 200 }), tcp: async () => true, nowMs: () => 1000 + 3 * 60000 }));
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
    fetcher: async () => { throw new Error('ENOTFOUND'); }, tcp: async () => false }));
  assert.deepEqual([rows.chain.running, rows.chain.probe.ok], [false, false]); assert.match(rows.chain.probe.says, /ECONNREFUSED/);
  assert.match(rows.guardian.probe.says, /does not answer/);
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
