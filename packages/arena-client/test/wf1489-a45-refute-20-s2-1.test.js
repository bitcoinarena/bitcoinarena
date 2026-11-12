// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 a45 refute 20, skeptic 2 (stranger against an HONEST door, variant of #1853 / #2264): payOutLiquidation pays each pass's
// due notes as one batch, one row per payout key, appended to v.payouts (newest last). A payout key is public (GET
// /liquidation-claims plan lists it per note). A stranger who holds a few dust notes of the halted federation presents them late,
// one per pass, naming the VICTIM's payoutPk: the honest door now lists 16 newer real rows for the victim in that federation.
// collectLiquidationPayouts reads newest first and claims at most MAX_LIQUIDATION_PAYOUTS_PER_FEDERATION (16) per federation,
// so the victim's own (older, large) payout is never claimed. Safe behaviour: the victim's real payout is still collected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectLiquidationPayouts, liquidationKeyFor } from '../src/liquidation-claim.js';

const store = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };

test('16 dust payouts a stranger gifts to the victim\'s key on an honest door starve the victim\'s own payout', async () => {
  const curve = { pointX: (s) => new Uint8Array(32).map((_, i) => s[i] ^ 0x5a) };
  const seed = new Uint8Array(32).fill(5);
  const fed = 'ab'.repeat(32);
  const { payoutPk } = liquidationKeyFor(seed, fed, curve);
  const into = 'ee'.repeat(32);
  const payouts = [{ federation: fed, payoutPk, txid: '77'.repeat(32), outIdx: 1, msat: '50000000', into }];   // batch 1: the victim's notes
  for (let b = 2; b <= 17; b++) payouts.push({ federation: fed, payoutPk, txid: b.toString(16).padStart(64, '0'), outIdx: 0, msat: '1000', into });   // batches 2..17: one gifted dust note each
  const refunded = [];
  const client = { refund: async (txid) => { refunded.push(txid); return JSON.stringify({ accepted: true }); } };
  const got = await collectLiquidationPayouts({ listed: { payouts }, seed, curve, clientFor: async () => client, storage: store(), federations: [fed] });
  assert.ok(refunded.includes('77'.repeat(32)), `the victim's 50000000 msat payout was never refunded (${refunded.length} dust refunds made instead)`);
  assert.ok(got.some((g) => g.ok && g.msat === '50000000'));
});
