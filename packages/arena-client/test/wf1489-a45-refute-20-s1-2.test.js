// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 a45 refute 20 (honest path of #1853): the arbiter's GET /liquidation-payouts lists every liquidation it ever paid
// (tools/arbiter.mjs: Object.entries(state.liquidations) - oldest first, never pruned), and the page reads it with no
// ?federation=. MAX_LIQUIDATION_FEDERATIONS (32) counts the federations of ALL rows, other players' too, so once an honest
// set has paid 32 liquidations, a player's payout in the 33rd (the newest) is skipped for good and never collected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectLiquidationPayouts, liquidationKeyFor } from '../src/liquidation-claim.js';

const store = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };

test('an honest list of 33 liquidated federations still pays this player\'s payout in the newest one', async () => {
  const curve = { pointX: (s) => new Uint8Array(32).map((_, i) => s[i] ^ 0x5a) };
  const seed = new Uint8Array(32).fill(5);
  const other = new Uint8Array(32).fill(9);   // another player
  const payouts = [];
  for (let i = 0; i < 32; i++) {
    const f = (i + 1).toString(16).padStart(2, '0').repeat(32);
    payouts.push({ federation: f, payoutPk: liquidationKeyFor(other, f, curve).payoutPk, txid: f, outIdx: 0, msat: '1000', into: 'ee'.repeat(32) });
  }
  const mine = 'ab'.repeat(32);
  payouts.push({ federation: mine, payoutPk: liquidationKeyFor(seed, mine, curve).payoutPk, txid: '77'.repeat(32), outIdx: 1, msat: '50000', into: 'ee'.repeat(32) });
  let refunds = 0;
  const client = { refund: async () => { refunds++; return JSON.stringify({ accepted: true }); } };
  const got = await collectLiquidationPayouts({ listed: { payouts }, seed, curve, clientFor: async () => client, storage: store() });
  assert.equal(refunds, 1, 'this player\'s own payout was never collected');
  assert.ok(got.some((g) => g.ok && g.msat === '50000'));
});
