// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { b32, LOSER, wait } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { testAttestedGame } from './plugins/sign.js';
import { TEST_DONATION_SET_KEYS_REGTEST } from '../../arena-protocol/src/test-donation-set-keys-regtest.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { YES, NO, bookBatchId } from '../../arena-protocol/src/order-book.js';
import { UP_DOWN_OUTCOMES } from '../../arena-protocol/src/up-down.js';
import { toHex } from '../../arena-protocol/src/hash.js';

// kanban #1489 state machine audit (markets, SM-1 order batch): A SEAT THAT SIGNED THE LOSING SET OF AN EQUIVOCATED BATCH STAYS SIGNED FOR GOOD.
// k1's leader signs two sets: A goes to four honest seats (5 signatures with its own: certified), B to the two others. The #1697/#1886
// DECIDED branch lets the leaders move on, but the two B signers can never leave SIGNED: certify(A) refuses ("this seat holds another set"),
// applyVoid refuses (A has 5 signers, too few seats that cannot sign it), and no other move exists. pending() names k1 there forever, so
// #signGuard refuses every later batch, #bookPlan refuses the settlement and standing() answers inPending for every order (return door shut).
// The book then needs all five other seats - the faulty leader among them - for every batch, the settlement and every return.

const UPDOWN = testAttestedGame({ name: 'btc-updown-15m', outcomes: [...UP_DOWN_OUTCOMES] });
const NETWORK = TEST_DONATION_SET_KEYS_REGTEST.recipients;
const ROUND = { gameId: UPDOWN.registration.gameId, simCoreHash: b32(0), configHash: b32(0), donationSetId: donationSetId(NETWORK), entryCloseMs: 900000n };
const player = (n) => ({ ...LOSER, name: `wf${n}`, key: b32(0x60 + n), worldSecret: b32(0) });

// kanban #3225: `handed` - the certificate reaches the B seats (POST /batch-certificate, the book read); else only a B seat's own lead
// meets it, in the A signers' void-ask answers (#decide's DECIDED branch)
const run = (handed) => async () => {
  const w = await lockRound({ n: 7, stakeMsat: 10_000n, round: ROUND, endMs: testNow() + 1800000,
    serveOpts: { plugins: [NEXTBLOCK, UPDOWN.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST], orderBatchTimer: false } });
  skipTo(Number(w.c.committeeTimeMs) + 100);
  try {
    const B = 1000;
    for (const d of w.nodes) d.orderBook.intervalMs = B;
    const at = async (k) => { while (testNow() < (k + 1) * B) await wait(5); };
    const leaderOf = (k) => w.nodes.find((d) => d.orderBook.leads(w.rid, k));
    await lockAndPlay(w, player(1), { noMarks: true, pick: YES, order: { price: 52000n } });
    await lockAndPlay(w, player(2), { noMarks: true, pick: NO, order: { price: 50000n } });
    const k1 = Math.floor(testNow() / B);
    await at(k1);
    const bad = leaderOf(k1);
    const badPub = toHex(bad.orderBook.round.pubkey);
    const orders = bad.orderBook.proposal(w.rid, k1).orders;
    assert.ok(orders.length >= 2, 'the leader holds both orders tradable');
    const sign = (ids) => {
      const rec = { k: String(k1), orders: ids, cancels: [], sells: [], leader: badPub };
      rec.leaderSig = toHex(schnorr.sign(bookBatchId({ roundId: w.rid, k: BigInt(k1), orderIds: ids }), bad.orderBook.round.identity.secret));
      return rec;
    };
    const A = sign([...orders]), Bset = sign([orders[0]]);
    const honest = w.nodes.filter((d) => d !== bad);
    const aSeats = honest.slice(0, 4), bSeats = honest.slice(4);
    const sigsA = [bad, ...aSeats].map((d) => { const r = d.orderBook.accept(w.rid, A); assert.equal(r.ok, true, r.why); return { seat: r.seat, signature: r.signature }; });
    for (const d of bSeats) { const r = d.orderBook.accept(w.rid, Bset); assert.equal(r.ok, true, r.why); }
    // A carries the threshold: certified at its five signers - the book the network holds for k1
    for (const d of [bad, ...aSeats]) assert.equal(d.orderBook.certify(w.rid, { record: A, sigs: sigsA }).ok, true);
    const refusedCert = handed ? bSeats.map((d) => d.orderBook.certify(w.rid, { record: A, sigs: sigsA })) : [];
    // the honest leaders go on deciding: an A seat's batch, then a B seat's own
    await lockAndPlay(w, player(3), { noMarks: true, pick: YES, order: { price: 53000n } });
    await lockAndPlay(w, player(4), { noMarks: true, pick: NO, order: { price: 49000n } });
    let k2 = Math.floor(testNow() / B); while (!aSeats.includes(leaderOf(k2))) k2++;
    await at(k2);
    const got2 = await leaderOf(k2).orderBook.lead(w.rid, k2);
    let k3 = k2 + 1; while (!bSeats.includes(leaderOf(k3))) k3++;
    await at(k3);
    const got3 = await leaderOf(k3).orderBook.lead(w.rid, k3);
    const report = bSeats.map((d) => ({ state: d.orderBook.batchState(w.rid, k1), pending: d.orderBook.pending(w.rid),
      inPending: d.orderBook.standing(w.rid, Buffer.from(orders[1], 'hex')).inPending }));
    const info = JSON.stringify({ k1, certAtB: refusedCert.map((r) => r.why || 'ok'), lead2: got2.ok ? { heldBy: got2.heldBy, refused: got2.refused } : got2.why,
      lead3: got3.ok ? got3 : got3.why, report });
    if (!handed) {
      // the B seat that led k3 took A's certificate from the void-ask answers; the other one meets it at its own turn or its book read
      const led = bSeats.indexOf(leaderOf(k3));
      assert.equal(got3.ok, true, `the B seat leads k3 once k1 is decided: ${info}`);
      assert.equal(report[led].state, 'CERTIFIED', `the B seat that led k3 holds k1 certified under A: ${info}`);
      assert.ok(!report[led].pending.includes(k1), info);
      return;
    }
    for (const r of report) {
      assert.notEqual(r.state, 'SIGNED', `a B seat holds batch ${k1} SIGNED for good while set A is certified: ${info}`);
      assert.ok(!r.pending.includes(k1), `batch ${k1} stays pending at a B seat: ${info}`);
      assert.equal(r.inPending, false, `every order's return waits at a B seat: ${info}`);
    }
  } finally { await w.close(); }
};

test('an honest seat that signed the other set of a batch certified under another set leaves SIGNED', run(true));
test('a B seat that leads a later batch takes the other set\'s certificate from the void-ask answers (kanban #3225)', run(false));
