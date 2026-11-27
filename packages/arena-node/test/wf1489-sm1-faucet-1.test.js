// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1489 sm1-faucet-1 (state machine audit, SM-22 reward link open -> paying -> paid | open): settle() decides on the row it read at the START
// of its pass. The faucet runs it every 60 s from setInterval with no guard against a pass still running, and each `paying` row costs one
// `lncli listpayments` of up to 20 s - so with a slow lnd two passes overlap. The later pass reads the old payment FAILED and opens the link; the
// player's wallet claims again (a new invoice, a new payment, still in flight); the older pass then reaches the same row with its stale copy, asks
// for the OLD hash (failed), and sets the row open again by `WHERE state = 'paying'` - while the new payment is in flight. A third claim pays again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openFeedbackStore, FEEDBACK_KIND } from '../src/feedback-store.js';
import { eventId } from '../src/nostr-relay.js';

const hex = (b) => Buffer.from(b).toString('hex');
const key = (n) => { const secret = new Uint8Array(32).fill(n); return { secret, pubkey: hex(schnorr.getPublicKey(secret)) }; };
const report = (k, happened) => {
  const e = { pubkey: k.pubkey, created_at: Math.floor(Date.now() / 1000), kind: FEEDBACK_KIND, tags: [['t', 'bug']],
    content: JSON.stringify({ happened: `${happened} Steps: opened the lobby, joined a round, watched the screen.`, expected: 'it to work' }) };
  e.id = eventId(e); e.sig = hex(schnorr.sign(Buffer.from(e.id, 'hex'), k.secret)); return e;
};
const approved = (s, k, words, sats) => { const e = report(k, words); s.take(e); assert.equal(s.approve(e.id, sats, { played: () => true }).ok, true); return e.id; };

test('#1489 sm1-faucet-1: an older settle pass never reopens a link whose NEW payment is in flight', async () => {
  const s = openFeedbackStore();
  const alice = key(1), bob = key(2);
  const decode = async (inv) => ({ ok: true, amountSats: Number(inv.split(':')[1]), paymentHash: `h-${inv}` });
  const inFlight = async () => ({ ok: false, why: 'the payment timed out' });
  const T = Date.now();
  // two rewards whose payments were left unknown (a restart mid-pay, a timeout): both `paying`
  const k1 = s.createReward(approved(s, alice, 'first bug for the settle race', 1000)).reward.k1;
  const k2 = s.createReward(approved(s, bob, 'second bug for the settle race', 2000)).reward.k1;
  await s.claim(k1, 'inv1:1000', { decode, pay: inFlight, nowMs: T });
  await s.claim(k2, 'inv2:2000', { decode, pay: inFlight, nowMs: T });
  assert.deepEqual([s.reward(k1).state, s.reward(k2).state], ['paying', 'paying']);

  // pass A: lnd hangs on the first row (lncli's 20 s), so the pass is still running when the next one starts
  let release; const gate = new Promise((r) => { release = r; });
  const passA = s.settle({ nowMs: T + 200000, status: async (h) => { if (h === 'h-inv1:1000') { await gate; return 'unknown'; } return 'failed'; } });
  await new Promise((r) => setImmediate(r));
  // pass B (60 s later, lnd answers again): the second reward's old payment FAILED -> its link is open
  await s.settle({ nowMs: T + 260000, status: async (h) => (h === 'h-inv2:2000' ? 'failed' : 'unknown') });
  const afterB = s.reward(k2).state;
  // the player's wallet claims again: a new invoice, the payment in flight
  const again = await s.claim(k2, 'inv2b:2000', { decode, pay: inFlight, nowMs: T + 261000 });
  const afterClaim = { state: s.reward(k2).state, hash: s.reward(k2).paymentHash };
  // pass A goes on with its stale row of k2: the OLD hash failed -> it opens the link under the new payment
  release(); await passA;
  const end = s.reward(k2);
  // and a third claim pays a second time while the second payment may still land
  let paid = 0;
  const third = await s.claim(k2, 'inv2c:2000', { decode, pay: async () => { paid++; return { ok: true, paymentHash: 'h-third' }; }, nowMs: T + 262000 });
  console.log('  MEASURED #1489 sm1-faucet-1:', JSON.stringify({ afterB, again: again.reason, afterClaim, endState: end.state, endHash: end.paymentHash, third: third.status, thirdPaid: paid }));
  assert.equal(afterB, 'open');
  assert.deepEqual(afterClaim, { state: 'paying', hash: 'h-inv2b:2000' });
  assert.equal(end.state, 'paying', 'a settle pass reading an OLD payment hash reopened the link while its new payment is in flight');
  assert.equal(paid, 0, 'the reward was paid again while an earlier payment of it was in flight');
});
