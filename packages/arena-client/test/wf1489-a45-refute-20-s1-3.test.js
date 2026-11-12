// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2252 / #2264: the page hands collectLiquidationPayouts the federations it holds or that signed liquidation events name;
// a row of any other federation costs no key derivation, and a held federation's payout is collected even behind 1000 others.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectLiquidationPayouts, liquidationKeyFor } from '../src/liquidation-claim.js';

const store = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };

test('only the named federations are derived; this player\'s oldest payout is collected behind 1000 other federations', async () => {
  const plain = { pointX: (s) => new Uint8Array(32).map((_, i) => s[i] ^ 0x5a) };
  let derivations = 0;
  const curve = { pointX: (s) => { derivations++; return plain.pointX(s); } };
  const seed = new Uint8Array(32).fill(5);
  const mine = 'ab'.repeat(32);
  const payouts = [{ federation: mine, payoutPk: liquidationKeyFor(seed, mine, plain).payoutPk, txid: '77'.repeat(32), outIdx: 1, msat: '50000', into: 'ee'.repeat(32) }];
  for (let i = 0; i < 1000; i++) { const f = (i.toString(16).padStart(8, '0') + 'cd'.repeat(28)).slice(0, 64); payouts.push({ federation: f, payoutPk: 'ff'.repeat(33), txid: f, outIdx: 0, msat: '1', into: f }); }
  payouts.push({ ...payouts[0] });   // the same outpoint listed twice is claimed once
  let refunds = 0;
  const client = { refund: async () => { refunds++; return JSON.stringify({ accepted: true }); } };
  const got = await collectLiquidationPayouts({ listed: { payouts }, seed, curve, clientFor: async () => client, storage: store(), federations: [mine, 'zz'] });
  assert.equal(derivations, 1);
  assert.equal(refunds, 1);
  assert.ok(got.some((g) => g.ok && g.msat === '50000'));
});
