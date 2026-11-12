// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 r7 (attacker audit, find-client): collectLiquidationPayouts has NO limit on the payout list it reads from the
// arbitration door's GET /liquidation-payouts (index.html: `listed = await r.json()` then collectLiquidationPayouts({listed,...})).
// It derives one claim key (playerSecretFor + curve.pointX, one EC multiply) for EVERY entry in listed.payouts, before any
// match. The operator at that signed door - or any peer answering it - can list hundreds of thousands of junk payouts and
// make the honest player's tab do one key derivation each, freezing it. Same unbounded-work pattern as the owed /settled
// scan (#1499), at a DIFFERENT door that has no such cap. Safe behaviour: the number of key derivations is bounded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectLiquidationPayouts } from '../src/liquidation-claim.js';

const store = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };

test('a padded GET /liquidation-payouts answer costs one claim-key derivation per listed payout (unbounded)', async () => {
  let derivations = 0;
  const curve = { pointX: (_secret) => { derivations++; return new Uint8Array(32).fill(7); } };   // the one EC multiply per key
  const seed = new Uint8Array(32).fill(5);
  // The player holds a wallet in ONE real federation; an honest door lists at most a handful of this seed's payouts.
  const N = 20000;
  const payouts = [];
  for (let i = 0; i < N; i++) {
    const fed = (i.toString(16).padStart(8, '0') + 'ab'.repeat(28)).slice(0, 64);   // a distinct valid 32-byte federation id hex
    payouts.push({ federation: fed, payoutPk: 'ff'.repeat(33), txid: '00'.repeat(32), outIdx: 0, msat: '1000', into: fed });   // payoutPk never matches this seed's
  }
  const listed = { payouts };
  const clientFor = async () => { throw new Error('no payout of this list names this seed, so no wallet is opened'); };
  await collectLiquidationPayouts({ listed, seed, curve, clientFor, storage: store() });
  // A player's own payouts are few; a door should not be able to make the tab derive a key for an unbounded list.
  assert.ok(derivations <= 1000, `collectLiquidationPayouts derived ${derivations} claim keys for a ${N}-entry list: the door's list is read with no cap`);
});
