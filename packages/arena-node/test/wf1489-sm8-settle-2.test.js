// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 sm8 settle 2: a late loser's send plan in a round that takes any federation reads the ROUND's federation rows as its settlement state.
// round.js lateSendScope overrides lockSettlement (the late row) but not settlementState's fallback: with no late row yet, settlementState falls through
// to fedLockSettlementsOf - the round's own federations, every one ACCEPTED (a late settlement exists only after them). winnings-send.js stateOf then
// reads ACCEPTED for a late settlement nothing has signed, so `replaceable` is false (a lower plan from a seat never replaces the kept one: two late
// askers' plans split the peers for good) and `dropIfStale` never drops a plan the payout no longer matches. A round in one federation answers right.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { WinningsSend } from '../src/winnings-send.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const RID = b32(0x5e), LATE = b32(0x14), RECIPIENT = b32(0x77);
const A = 'aa'.repeat(32), B = 'bb'.repeat(32);
const LNURL = 'lnurl1dp68gurn8ghj7ctsdyhxcmndv9exket5wvhxxmmd9akxuatjd3cz7mrww4exctmsv9usxr8j7m';
const plan = (msat, hash) => ({ entryId: RECIPIENT, roundId: RID, attempt: 0, address: LNURL, invoice: 'lntb1x', paymentHash: hash, invoiceMsat: msat - 1000n,
  payoutMsat: msat, owedMsat: msat, gatewayUrl: 'https://gw/', gatewayPk: '03' + 'cd'.repeat(32), expiration: 900n, donation: true, why: 'proposed by this signer node' });
// the late base plan as lateMessage builds it: one donation share of the late loser's lock, now for 24 000 msat (the fee rule moved)
const base = { plan: { payouts: [{ kind: 'donation', donation: { id: RECIPIENT, lnurl: LNURL }, msat: 24000n, owedMsat: 24000n }] }, entryOf: new Map() };

function world({ anyFederation }) {
  const round = new Round(openStore(':memory:'));
  round.db.exec('PRAGMA foreign_keys = OFF');   // the round is this test's stub, not a row
  if (anyFederation) for (const f of [A, B])
    round.putFedLockSettlement({ roundId: RID, federation: f, txid: f, message: b32(1), signature: b32(2), state: 'ACCEPTED', why: 'the round\'s own settlement in that federation' });
  const scope = round.lateSendScope(LATE);
  scope.putSendPlan(plan(25000n, 'ee'.repeat(32)));   // the late send plan kept here, sized before the fee rule moved
  const w = new WinningsSend({ round: scope, port: null, curve: null, random: null, peersFor: () => [], fetcher: null });
  return { round, scope, w };
}

test('a late send plan with no late settlement signed is replaceable and dropped when stale - in one federation and in a round that takes any federation', () => {
  const one = world({ anyFederation: false });
  assert.equal(one.scope.lateLockSettlement(RID, LATE), null, 'no late settlement row');
  assert.equal(one.w.replaceable(RID), true, 'one federation: nothing of the late settlement signed, the plan may give way');
  const anyF = world({ anyFederation: true });
  assert.equal(anyF.scope.lateLockSettlement(RID, LATE), null, 'no late settlement row here either');
  const state = anyF.scope.settlementState(RID);
  console.log('  MEASURED sm8-settle-2:', JSON.stringify({ lateRow: null, lateScopeSettlementState: state, replaceable: anyF.w.replaceable(RID) }));
  assert.equal(anyF.w.replaceable(RID), true, `any federation: the late send plan reads the round's own federation rows (${state}) as its settlement and never gives way`);
  assert.equal(anyF.w.dropIfStale(RID, base), true, 'a late plan of 25 000 msat the 24 000 msat payout no longer matches is dropped while nothing late is signed');
});
