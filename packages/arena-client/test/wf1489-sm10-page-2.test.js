// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WF1489 sm10 page-2: A LIQUIDATION PAYOUT COLLECTED WHILE ITS NOTE COULD NOT BE WRITTEN IS NEVER FINAL.
// collectLiquidationPayouts (liquidation-claim.js) refunds a payout into the player wallet and then writes its note
// (arena-liquidation-paid-<txid>:<idx>) with a raw setItem - no putRoomy, no storage-full handler. A full browser refuses that write (or the
// tab closes between the refund's acceptance and the write): the payout is in the wallet, the pass answers ok:false with the quota error,
// and from then on every pass (the page's timer, every 10 min) refunds it again, the guardians hold no contract there any more (spent by
// this key, the only one that can), and the answer is "the federation did not accept the refund" - ok:false, not kept, for good. The
// payout is collected and the page says it is failing forever; nothing ever books it.
// Safe: a payout the guardians no longer hold (stored_before null) after this key's own refund is final - collected, said so once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '../../arena-node/node_modules/@noble/curves/secp256k1.js';
import { collectLiquidationPayouts, liquidationKeyFor } from '../src/liquidation-claim.js';

const curve = { pointX: (sk) => schnorr.getPublicKey(sk) };
const SEED = new Uint8Array(32).fill(0x5e), FED = 'fe'.repeat(32), SAFE = 'aa'.repeat(32), TXID = 'cd'.repeat(32);

test('sm10 page-2: a liquidation payout whose note a full browser refused is final on the next pass, not failing for good', async () => {
  const m = new Map();
  let full = true;
  const storage = { getItem: (k) => (m.has(k) ? m.get(k) : null), removeItem: (k) => m.delete(k),
    setItem: (k, v) => { if (full) { const e = new Error('The quota has been exceeded.'); e.name = 'QuotaExceededError'; throw e; } m.set(k, String(v)); } };
  const key = liquidationKeyFor(SEED, FED, curve);
  const listed = { payouts: [{ federation: FED, into: SAFE, payoutPk: key.payoutPk, txid: TXID, outIdx: 0, msat: '768000' }] };
  const fed = { stored: true, walletMsat: 0n };
  const client = { refund: async () => {
    if (!fed.stored) return JSON.stringify({ accepted: false, stored_before: null, error: 'no contract at that outpoint' });
    fed.stored = false; fed.walletMsat += 768000n; return JSON.stringify({ accepted: true });
  } };
  const first = await collectLiquidationPayouts({ listed, seed: SEED, curve, clientFor: async () => client, storage });
  assert.equal(fed.walletMsat, 768000n, 'the payout reached the wallet');
  // the browser has room again (tidied), and later passes run
  full = false;
  const passes = [];
  for (let i = 0; i < 3; i++) passes.push((await collectLiquidationPayouts({ listed, seed: SEED, curve, clientFor: async () => client, storage }))[0]);
  console.log(`  FACTS sm10-page-2: wallet ${fed.walletMsat} msat; first pass ok=${first[0].ok} (${first[0].why}); later passes ${passes.map((p) => `ok=${p.ok} kept=${!!p.kept} (${p.why})`).join(' | ')}`);
  assert.ok(passes.every((p) => p.ok), 'the collected payout is final once its contract is spent by this key - not "the federation did not accept the refund" on every pass');
});
