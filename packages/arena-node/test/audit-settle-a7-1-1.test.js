// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// audit-2026-11-24 settle round 1, finding 1 (gap in the #2737 fix, the summaryOf twin of #3312): summaryOf keeps a rebuilt summary
// in `summaries`, an insertion-ordered Map that drops its oldest past 4096 rounds. GET /lock-settlement?round=<id> (a one-federation
// round) and GET /settled walk summaryOf, are public and unthrottled. A stranger who reads 4097 settled rounds in turn drops each
// round's kept summary just before that round is read again, so every read runs planOf again (entries, finality, locks, fee locks,
// gifts, committee, fees) on the seat's event loop. #2737 named this cycle and fixed only the miss path; #3312 fixed the same cycle
// only for fedSummary (any-federation rounds), with a store of 20,000 for settled rounds.
// SAFE: a settled round whose summary was rebuilt once is not rebuilt again on each further public read.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LockSettlement } from '../src/settlement.js';
import * as curve from '../src/curve.js';

const ROUNDS = 4097;
const ridOf = (i) => { const r = new Uint8Array(32); r[0] = 0x5e; r[1] = (i >> 16) & 0xff; r[2] = (i >> 8) & 0xff; r[3] = i & 0xff; return r; };

test('summaryOf: reading 4097 settled rounds in turn does not rebuild every plan on every read', async () => {
  const round = {
    get: () => null,
    lockSettlement: () => ({ state: 'ACCEPTED', txid: 'aa'.repeat(32) }),
    // the moves this seat kept at signing: 1 claim, 1 payout - the rebuilt plan matches them, so the summary is kept
    lockSettlementMoves: () => ({ txid: 'aa'.repeat(32), claims: ['bb'.repeat(32) + ':0'], payouts: 1 }),
  };
  const s = new LockSettlement(round, { curve, random: () => new Uint8Array(32), dkg: {}, port: { settle: async () => ({}) } });
  let rebuilt = 0;
  s.planOf = async () => {
    rebuilt++;
    return { ok: true, plan: { claims: [{ kind: 'stake', amountMsat: 1000n, outpoint: { txid: new Uint8Array(32).fill(0xbb), outIdx: 0n } }],
      payouts: [{ kind: 'qualifier', payoutPk: new Uint8Array(33).fill(2), msat: 900n, feeMsat: 0n }],
      poolMsat: 1000n, inputFeesMsat: 0n, paidMsat: 900n } };
  };
  // three passes of a stranger's reads over 4097 settled rounds (GET /lock-settlement?round=<id>, one after another)
  const PASSES = 3;
  for (let p = 0; p < PASSES; p++) for (let i = 0; i < ROUNDS; i++) assert.ok(await s.summaryOf(ridOf(i)), 'the summary of a settled round is answered');
  assert.ok(rebuilt <= ROUNDS, `${rebuilt} whole-plan rebuilds for ${PASSES * ROUNDS} public reads of ${ROUNDS} settled rounds (at most ${ROUNDS}: once each)`);
});
