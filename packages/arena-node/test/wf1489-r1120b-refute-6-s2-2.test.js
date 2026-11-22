// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Refute #3148 (kanban #1489 r1120b-refute-6-s2): the caps bound the package's carried lists, not its manifest's. networkPackageId
// spreads m.donationSets, m.rotations and m.series and hashes their JSON before any cap on them, and new Set() walks them again.
// A manifest list sent as one long string spreads into one element per character: a ~15 MB GET /network answer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkNetworkPackage } from '../src/network-check.js';
import { ASK_MS } from '../src/core-sandbox.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';

test('refute #3148: a manifest whose lists are megabytes long is refused without holding the thread', () => {
  const big = 'a'.repeat(5 * 1048576);
  const manifest = { chain: 'bitcoin-regtest', networkId: toHex(NETWORK_ID_REGTEST), federationId: toHex(TEST_FEDERATION_ID), donationSets: big, rotations: big, series: big };
  const pkg = JSON.parse(JSON.stringify({ format: 'arena-network/v1', title: 'x', manifest, invite: '', donationSets: [], rotations: [], series: [] }));
  const bytes = Buffer.byteLength(JSON.stringify(pkg));
  const t0 = Date.now();
  let v; try { v = checkNetworkPackage(pkg, { verify: () => false, seatChain: 'bitcoin-regtest' }); } catch (e) { v = { ok: false, why: 'threw ' + e.message }; }
  const held = Date.now() - t0;
  console.log(`manifest-list package ${bytes} bytes: held ${held} ms; ok=${v.ok} ${String(v.why || '').slice(0, 120)}`);
  assert.equal(v.ok, false);
  assert.ok(held <= ASK_MS, `checking one ${Math.round(bytes / 1024)} kB network package held the seat's thread ${held} ms (ASK_MS ${ASK_MS})`);
});
