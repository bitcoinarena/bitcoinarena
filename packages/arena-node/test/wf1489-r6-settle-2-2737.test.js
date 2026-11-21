// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 wf1489-r6-settle-2: GET /settled is public and unthrottled; for each of up to 500 listed rounds it awaits
// settlements.summaryOf(round). summaryOf keeps a summary only when this seat's rebuilt plan matches the kept moves; a round whose
// rebuild does not match (a row made ACCEPTED on another asker's txid, #2277; a game version no longer hosted; any refusal of
// planOf) is answered null and NOT remembered - so every GET /settled from a stranger rebuilds the whole plan of every such round
// again (entries, results, finality, locks, fee locks, gifts, lockSettlement), up to 500 per request, with no cost to the asker.
// The safe behaviour: a round whose summary could not be rebuilt is not rebuilt again on the next public read right away.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LockSettlement } from '../src/settlement.js';
import * as curve from '../src/curve.js';

const RID = new Uint8Array(32).fill(0x5e);

test('GET /settled: a settled round whose plan does not rebuild to its kept moves is not rebuilt on every public read', async () => {
  const round = {
    get: () => null,
    lockSettlement: () => ({ state: 'ACCEPTED', txid: 'aa'.repeat(32) }),
    // the landed txid's moves: 2 claims, 3 payouts (another asker's plan, #2277)
    lockSettlementMoves: () => ({ txid: 'aa'.repeat(32), claims: ['bb'.repeat(32) + ':0', 'cc'.repeat(32) + ':1'], payouts: 3 }),
  };
  const s = new LockSettlement(round, { curve, random: () => new Uint8Array(32), dkg: {}, port: { settle: async () => ({}) } });
  let rebuilt = 0;
  // this seat's own plan: the same claims, 2 payouts - it never matches the landed txid's moves
  s.planOf = async () => {
    rebuilt++;
    return { ok: true, plan: { claims: [{ amountMsat: 1n }, { amountMsat: 1n }], payouts: [{ payoutPk: new Uint8Array(33), msat: 1n, feeMsat: 0n }, { payoutPk: new Uint8Array(33), msat: 1n, feeMsat: 0n }],
      poolMsat: 2n, inputFeesMsat: 0n, paidMsat: 2n } };
  };
  // a stranger's GET /settled, 50 times (each one walks every listed round through summaryOf)
  for (let i = 0; i < 50; i++) assert.equal(await s.summaryOf(RID), null);
  assert.ok(rebuilt <= 1, `the round's whole plan was rebuilt ${rebuilt} times for 50 public GET /settled reads`);
});
