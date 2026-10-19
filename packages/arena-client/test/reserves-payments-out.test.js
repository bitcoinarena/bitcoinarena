// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE PAYMENTS OUT OF THE RESERVES ON THE ARENA PAGE (§27A.9.32026-10-17: "Build the Payments out list and its
// 5 tests as named in comment 2647"): a payout is shown only once five nodes list it and hold its proposal's vote as passed; a passed
// vote without a payout is pending; a drained federation's move needs no vote. (The games screen's list was taken out again,
// 2026-10-17: "remove ... the reserve accordion"; the reserves are shown on bitcoin-arena.io - home-reserves.test.js.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { reservesPaymentsOut, fetchReservesPaymentsOut, paymentOutLine } from '../src/reserves-page.js';

const P = 'aa'.repeat(32), MOVE = 'bb'.repeat(32), FA = '33'.repeat(32), FB = '44'.repeat(32);
const proposal = (state, count = { turnoutPct: 41.5, approvalPct: 72.25, passed: state === 'passed' }) => ({ id: P, purpose: 'Relay hosting', lnurl: 'dev@example.org',
  amountSats: '50000', vote: state === null ? null : { state, count } });
const paid = { proposal: P, planId: 'p1', federation: FA, state: 'PAID', plan: { kind: 'payout', amountSats: '50000', lnurl: 'dev@example.org' }, txid: 'cc'.repeat(32), preimage: 'dd'.repeat(32) };
const moved = { proposal: MOVE, planId: 'm1', federation: FA, state: 'CLAIMED', plan: { kind: 'move', to: FB, amountSats: '120000' }, txid: 'ee'.repeat(32), claimTxid: 'ff'.repeat(32) };
const nodes = (n, mk) => Array.from({ length: n }, (_, i) => mk(i));

test('1. a payout before its vote passed is not shown, and is reported as an inconsistency', () => {
  for (const vote of ['voting', 'failed', null]) {
    const r = reservesPaymentsOut({ answers: nodes(7, () => ({ payouts: [paid], proposals: [proposal(vote)] })) });
    assert.equal(r.ok, true, r.why);
    assert.equal(r.out.length, 0, `vote ${vote}: no payment out`);
    assert.equal(r.inconsistent.length, 1); assert.match(r.inconsistent[0].why, /its vote has not passed on 5 of them/);
  }
  const none = reservesPaymentsOut({ answers: nodes(7, () => ({ payouts: [paid], proposals: [] })) });
  assert.deepEqual([none.out.length, none.inconsistent.length], [0, 1], 'a payout for a proposal the nodes do not hold');
});

test('2. a passed vote is never missing: pending with no payout, exactly one payment out with its paid record', () => {
  const pend = reservesPaymentsOut({ answers: nodes(7, () => ({ payouts: [], proposals: [proposal('passed')] })) });
  assert.deepEqual([pend.out.length, pend.pending.length, pend.pending[0].lnurl, pend.pending[0].amountSats], [0, 1, 'dev@example.org', '50000']);
  const planned = reservesPaymentsOut({ answers: nodes(7, () => ({ payouts: [{ ...paid, state: 'PLANNED', txid: null, preimage: null }], proposals: [proposal('passed')] })) });
  assert.deepEqual([planned.out.length, planned.pending.length], [0, 1], 'a planned payout is still pending');
  const r = reservesPaymentsOut({ answers: nodes(7, () => ({ payouts: [paid], proposals: [proposal('passed')] })) });
  assert.equal(r.out.length, 1); assert.equal(r.pending.length, 0); assert.equal(r.inconsistent.length, 0);
  const o = r.out[0];
  assert.deepEqual([o.kind, o.lnurl, o.amountSats, o.status, o.vote.turnoutPct, o.vote.yesPct, o.agreeing], ['payout', 'dev@example.org', '50000', 'paid', 41.5, 72.25, 7]);
  assert.equal(paymentOutLine(o), `Relay hosting · dev@example.org · 50,000 sat · paid · vote 41.5 % turnout, 72.25 % YES · preimage ${'dd'.repeat(8)}… · tx ${'cc'.repeat(8)}…`);
});

test('3. fewer than five agreeing nodes: nothing is shown', () => {
  const four = reservesPaymentsOut({ answers: nodes(7, (i) => ({ payouts: i < 4 ? [paid] : [{ ...paid, preimage: '11'.repeat(32) }].slice(0, i % 2), proposals: [proposal('passed')] })) });
  assert.equal(four.out.length, 0, 'four list one record, the rest another or none');
  const votes4 = reservesPaymentsOut({ answers: nodes(7, (i) => ({ payouts: [paid], proposals: [proposal(i < 4 ? 'passed' : 'voting')] })) });
  assert.equal(votes4.out.length, 0, 'the vote passed on four only'); assert.equal(votes4.inconsistent.length, 1);
  const few = reservesPaymentsOut({ answers: nodes(4, () => ({ payouts: [paid], proposals: [proposal('passed')] })), asked: 7 });
  assert.equal(few.ok, false); assert.match(few.why, /only 4 of 7 nodes answered the payments out, and 5 must/);
});

test('4. a drained federation\'s move shows as moved to federation Y, with no vote', () => {
  const r = reservesPaymentsOut({ answers: nodes(7, () => ({ payouts: [moved], proposals: [] })) });
  assert.deepEqual([r.out.length, r.inconsistent.length, r.pending.length], [1, 0, 0]);
  const o = r.out[0];
  assert.deepEqual([o.kind, o.to, o.status, o.vote, o.amountSats, o.txid], ['move', FB, 'moved', null, '120000', 'ff'.repeat(32)]);
  assert.equal(paymentOutLine(o), `moved from federation 33333333 to federation 44444444 · 120,000 sat · moved · tx ${'ff'.repeat(8)}…`);
});
