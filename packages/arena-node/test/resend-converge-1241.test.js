// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1241 (audit 3 #1210 FIXES-9): two seats on turn each kept their own re-send attempt N+1 (first writer wins), the peers split between
// the two hashes and neither reached the threshold - the share stayed under the committee key for good. Attempt N+1 now has attempt 0's rule:
// a lower hash replaces a kept one nothing was signed on yet, so every seat meets on the lowest hash offered, in either order of delivery.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';

const b = (n) => new Uint8Array(32).fill(n);
const RID = b(0x5e), ENTRY = b(0x21);
const plan = (hash, attempt = 1) => ({ entryId: ENTRY, roundId: RID, attempt, address: 'donor@example.org', invoice: `lnbc-${hash.slice(0, 4)}`, paymentHash: hash,
  invoiceMsat: 9000n, payoutMsat: 9100n, owedMsat: 9500n, gatewayUrl: 'https://gw-b.example', gatewayPk: '02' + 'cd'.repeat(32), expiration: 1200n, why: 'test', donation: true });
const LOW = '11'.repeat(32), HIGH = 'ee'.repeat(32);
const seat = () => { const r = new Round(openStore(':memory:')); r.putSendPlan({ ...plan('aa'.repeat(32), 0), state: 'FAILED' }); return r; };
const hashOf = (r) => r.sendPlansOf(RID).find((x) => x.attempt === 1).paymentHash;
// what a seat does with an offered attempt 1 (checkResend's store steps): keep it if none is kept, replace a PLANNED one with a higher hash
const take = (r, hash) => { if (!r.putSendPlan(plan(hash))) r.replaceSendPlan(plan(hash)); return hashOf(r); };

test('#1241 two seats\' re-sends meet on the lower hash, whichever reaches a seat first', () => {
  const A = seat(), B = seat(), C = seat(), D = seat();
  // A and B on turn, each keeps its own; C gets A's (high) first then B's (low); D the other way round
  A.putSendPlan(plan(HIGH)); B.putSendPlan(plan(LOW));
  const c = [take(C, HIGH), take(C, LOW)], d = [take(D, LOW), take(D, HIGH)];
  // each proposer is offered the other's
  const a = take(A, LOW), bb = take(B, HIGH);
  const facts = { A: a.slice(0, 4), B: bb.slice(0, 4), C: c.map((x) => x.slice(0, 4)), D: d.map((x) => x.slice(0, 4)) };
  console.log('  MEASURED #1241:', JSON.stringify(facts));
  for (const h of [a, bb, c[1], d[1]]) assert.equal(h, LOW, 'a seat kept another attempt 1 than the lowest offered');
});

test('#1241 a re-send something was signed or funded on never moves; attempt 0 is not touched by this rule', () => {
  const r = seat();
  r.putSendPlan(plan(HIGH));
  r.db.prepare("UPDATE donation_sends SET state = 'FUNDING' WHERE attempt = 1").run();
  assert.equal(r.replaceSendPlan(plan(LOW)), false);
  assert.equal(hashOf(r), HIGH);
  const z = new Round(openStore(':memory:'));
  z.putSendPlan(plan(HIGH, 0));
  assert.equal(z.replaceSendPlan(plan(LOW, 0)), false);
});
