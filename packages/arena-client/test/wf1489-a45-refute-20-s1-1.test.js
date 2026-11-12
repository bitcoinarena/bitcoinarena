// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 a45 refute 20 (variant of #1853): the claim key is now derived once per federation, but every row that MATCHES the
// player's payout key still costs one clientFor + one client.refund (a wasm call and a round trip to the federation). The
// door learns this seed's payoutPk from the player's own POST /liquidation-claims, so it can list 20000 rows naming the
// player's real federation and payoutPk with junk txids: the page then makes 20000 refund calls. An honest list holds a
// player's few payouts per federation (notes, pending, remainder). Safe behaviour: matching rows are bounded too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectLiquidationPayouts, liquidationKeyFor } from '../src/liquidation-claim.js';

const store = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };

test('a door padding its list with rows naming the player\'s own payout key costs one refund call per row', async () => {
  const curve = { pointX: (s) => new Uint8Array(32).map((_, i) => s[i] ^ 0x5a) };
  const seed = new Uint8Array(32).fill(5);
  const fed = 'cd'.repeat(32);
  const { payoutPk } = liquidationKeyFor(seed, fed, curve);   // what the player POSTed to this door
  const N = 20000;
  const payouts = [];
  for (let i = 0; i < N; i++) payouts.push({ federation: fed, payoutPk, txid: i.toString(16).padStart(64, '0'), outIdx: 0, msat: '1000', into: fed });
  let refunds = 0;
  const client = { refund: async () => { refunds++; return JSON.stringify({ accepted: false, error: 'no such outpoint' }); } };
  await collectLiquidationPayouts({ listed: { payouts }, seed, curve, clientFor: async () => client, storage: store() });
  assert.ok(refunds <= 1000, `collectLiquidationPayouts made ${refunds} refund calls to the federation for a ${N}-row list naming one payout key`);
});
