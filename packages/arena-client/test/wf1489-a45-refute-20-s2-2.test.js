// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 a45 refute 20, skeptic 2 (retry/reload path of #2264): a payout whose Refund failed once (the safe federation's wallet
// was unreachable) is retried on the next page load - unless 16 newer rows for the same key were listed meanwhile. Rows already
// collected (`kept`, noted in storage) still count toward MAX_LIQUIDATION_PAYOUTS_PER_FEDERATION, so on every later reload the
// cap is spent on kept rows and the failed payout is never retried. Safe behaviour: a kept row costs no claim slot; the
// failed payout is retried.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectLiquidationPayouts, liquidationKeyFor } from '../src/liquidation-claim.js';

const store = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };

test('a payout whose first Refund failed is retried on reload even after 16 newer rows were collected', async () => {
  const curve = { pointX: (s) => new Uint8Array(32).map((_, i) => s[i] ^ 0x5a) };
  const seed = new Uint8Array(32).fill(5);
  const fed = 'ab'.repeat(32);
  const { payoutPk } = liquidationKeyFor(seed, fed, curve);
  const into = 'ee'.repeat(32);
  const big = '77'.repeat(32);
  const storage = store();
  const payouts = [{ federation: fed, payoutPk, txid: big, outIdx: 1, msat: '50000000', into }];
  let down = true;
  const client = { refund: async (txid) => { if (txid === big && down) throw new Error('the wallet is not reachable'); return JSON.stringify({ accepted: true }); } };
  // load 1: the refund fails (transient)
  let got = await collectLiquidationPayouts({ listed: { payouts }, seed, curve, clientFor: async () => client, storage, federations: [fed] });
  assert.ok(got.some((g) => g.txid === big && !g.ok));
  // later loads: one newer row per pass is listed and collected each time
  for (let b = 2; b <= 17; b++) {
    payouts.push({ federation: fed, payoutPk, txid: b.toString(16).padStart(64, '0'), outIdx: 0, msat: '1000', into });
    await collectLiquidationPayouts({ listed: { payouts }, seed, curve, clientFor: async () => client, storage, federations: [fed] });
  }
  down = false;   // the wallet is back
  const tried = [];
  const client2 = { refund: async (txid) => { tried.push(txid); return JSON.stringify({ accepted: true }); } };
  got = await collectLiquidationPayouts({ listed: { payouts }, seed, curve, clientFor: async () => client2, storage, federations: [fed] });
  assert.ok(tried.includes(big), 'the failed 50000000 msat payout is never retried: 16 kept rows fill the per-federation cap');
});
