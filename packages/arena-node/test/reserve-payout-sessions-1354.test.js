// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1354 (audit 4 fixesA-5, #1229): an attempt handed in to a stalled federation was marked EXPIRED at its cutoff while the guardians still
// held it queued; the co-signers expired it too, and the next turn's guardian signed attempt 2 from other inputs - when the federation took
// attempt 1, the proposal was paid twice. Now an attempt expires only after its federation ran EXPIRE_AFTER_SESSIONS sessions past the cutoff
// (`sessionsOf`, the halts book's reading): a stalled federation runs none, so nothing expires and nothing is signed again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as rp from '../src/reserve-payout.js';
import { world, PROPOSAL } from './reserve-payout-fixture.js';

const { PAYOUT } = rp;
const pass = async (w, heights) => { for (const h of heights) for (const s of w.seats) { try { await s.api.round({ height: h }); } catch { /* the next pass runs */ } } await w.deliver(); };
const heights = (from, to) => Array.from({ length: (to - from) / 2 + 1 }, (_, k) => from + 2 * k);
const states = (w) => w.seats.map((s) => (s.api.stateOf(PROPOSAL) || {}).state || '-').join(',');

// two reserve inputs, each enough alone: attempt 2 can pay from the one attempt 1 did not use
function stalledWorld() {
  const sess = { n: 40 };
  const w = world({ rows: [80000000n, 80000000n], amountSats: 70000n, more: () => ({ sessionsOf: () => ({ session: sess.n }) }) });
  const { settle } = w.port, queued = [];
  w.stalled = true;
  // the guardians queue a hand-in while they run no session; the tool times out, as fedimint-cli does
  w.port.settle = async (a) => { if (a.signature && w.stalled) { queued.push(a); throw new Error('timed out: the federation runs no session'); } return settle(a); };
  w.resume = async () => { w.stalled = false; for (const a of queued.splice(0)) await settle(a); sess.n += 3; };
  w.sess = sess;
  return w;
}

test('#1354 a hand-in queued at a stalled federation: nothing expires, no second attempt; the federation takes it and the proposal is paid once', async () => {
  const w = stalledWorld();
  await pass(w, [500]);
  await pass(w, heights(502, 560));   // far past PLAN_EXPIRY_BLOCKS: the federation stands still (session 40 throughout)
  const mid = states(w);
  console.log(`  #1354 stalled through height 560: ${mid}; ${w.fed.submits.length} taken`);
  assert.ok(!mid.includes(PAYOUT.EXPIRED), `an attempt expired while its federation stood still (${mid})`);
  assert.equal(w.fed.submits.length, 0);
  await w.resume();                  // the federation runs again and takes the queued attempt 1
  await pass(w, heights(562, 600));
  console.log(`  #1354 after the federation took it: ${states(w)}; ${w.fed.submits.length} transaction(s), ${w.fed.payments.length} payment(s)`);
  assert.equal(w.fed.submits.length, 1, `paid twice: ${w.fed.submits.length} transactions`);
  assert.equal(w.fed.payments.length, 1);
  assert.ok(w.seats.every((s) => s.api.stateOf(PROPOSAL).state === PAYOUT.PAID), states(w));
});

test('#1354 control: a federation that runs sessions and refused attempt 1 - the attempt expires after its sessions, and the next pays once', async () => {
  const sess = { n: 40 };
  const w = world({ rows: [80000000n, 80000000n], amountSats: 70000n, more: () => ({ sessionsOf: () => ({ session: sess.n }) }) });
  const { settle } = w.port;
  let refuse = true;
  w.port.settle = async (a) => (a.signature && refuse ? { accepted: false, error: 'the guardians refused it' } : settle(a));
  await pass(w, [500]);
  let expired = false;
  for (const h of heights(502, 530)) { sess.n += 1; await pass(w, [h]); expired = expired || states(w).includes(PAYOUT.EXPIRED); }
  assert.ok(expired, 'a refused attempt never expired while its federation ran sessions');
  refuse = false;
  for (const h of heights(532, 600)) { sess.n += 1; await pass(w, [h]); }
  console.log(`  #1354 control: ${states(w)}; ${w.fed.submits.length} transaction(s)`);
  assert.equal(w.fed.submits.length, 1);
  assert.ok(w.seats.every((s) => s.api.stateOf(PROPOSAL).state === PAYOUT.PAID), states(w));
});

test('#1354 a session count not read yet expires nothing', async () => {
  const w = world({ rows: [80000000n, 80000000n], amountSats: 70000n, more: () => ({ sessionsOf: () => null }) });
  const { settle } = w.port;
  w.port.settle = async (a) => (a.signature ? { accepted: false, error: 'refused' } : settle(a));
  await pass(w, [500]);
  await pass(w, heights(502, 560));
  assert.ok(!states(w).includes(PAYOUT.EXPIRED), states(w));
});
