// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ORDER BOOK'S BATCH STATES (kanban #1150, the state machine audit of 2026-11-06, critical). Seven seats of one Up/Down market round,
// each scenario of the ticket played against them as a leader seat (or a player with one) would:
//   A. A LATE LOWER k REORDERS FILLS AFTER "CANCELLED, UNFILLED": X rests, its cancel is certified in batch k3 and every seat says
//      "cancelled, unfilled"; then a leader posts batch k2 < k3 carrying a sell X buys. Before the fix every seat signed it, its
//      certificate went in before k3, and X filled after all.
//   B. ONE SIGNED SELL EXECUTED TWICE: A's sell fills in batch k4; a later batch carries the same signed sell again. Before the fix every
//      seat signed it, and the ledger set the sell again at its full size: A sold twice what it signed. A certificate of such a batch
//      (signed by five seats) was taken too.
//   C. A LATE BET: an order whose locks came after the market closed. Before the fix the honest leader of the batch whose cutoff follows
//      the close put it in that batch and it filled against the resting orders; and a back-dated batch, posted ten seconds after the
//      close (the outcome known), was signed by every seat.
// The facts of all three are printed first (MEASURED), then checked - so the same file run on the old source prints what it did.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { b32, LOSER, wait } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { testAttestedGame } from './plugins/sign.js';
import { TEST_DONATION_SET_KEYS_REGTEST } from '../../arena-protocol/src/test-donation-set-keys-regtest.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { bookBatchId, cancelId, sellId, YES, NO } from '../../arena-protocol/src/order-book.js';
import { UP_DOWN_OUTCOMES } from '../../arena-protocol/src/up-down.js';
import { lockFieldsToJson } from '../../arena-protocol/src/stake-lock.js';
import { toHex, fromHex, sha256 } from '../../arena-protocol/src/hash.js';

const UPDOWN = testAttestedGame({ name: 'btc-updown-15m-1150', outcomes: [...UP_DOWN_OUTCOMES] });
const NETWORK = TEST_DONATION_SET_KEYS_REGTEST.recipients;
const ROUND = { gameId: UPDOWN.registration.gameId, simCoreHash: b32(0), configHash: b32(0), donationSetId: donationSetId(NETWORK), entryCloseMs: 900000n };
const B = 500;
const player = (n) => ({ ...LOSER, name: `q${n}`, key: b32(0xa0 + n), worldSecret: b32(0) });
const cents = (c) => ({ price: BigInt(c) * 1000n });

test('kanban #1150: no batch below one a seat holds is signed, a signed sell is sold once, and nothing locked after the close trades - seven seats', { timeout: 170000 }, async () => {
  const w = await lockRound({ n: 7, stakeMsat: 10_000n, round: ROUND, endMs: testNow() + 1800000,
    serveOpts: { plugins: [NEXTBLOCK, UPDOWN.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST], orderBatchTimer: false } });
  skipTo(Number(w.c.committeeTimeMs) + 100);
  const rid = toHex(w.rid);
  const base = (d) => `http://127.0.0.1:${d.port}`;
  for (const d of w.nodes) d.orderBook.intervalMs = B;
  const order = (n, outcome, c, extra = {}) => lockAndPlay(w, player(n), { noMarks: true, pick: outcome, order: cents(c), ...extra });
  // ONE HONEST BATCH: the next cutoff on the seats' clock, led by the round's seat k mod 7
  const batch = async () => {
    const k = Math.floor(testNow() / B);
    while (testNow() < (k + 1) * B + 20) await wait(5);
    const got = await w.nodes.find((d) => d.orderBook.leads(w.rid, k)).orderBook.lead(w.rid, k);
    assert.equal(got.ok, true, got.why);
    return { ...got, k };
  };
  const leaderOf = (k) => w.nodes.find((d) => d.orderBook.leads(w.rid, k));
  // A SET FOR BATCH k BUILT AND SIGNED BY ITS LEADER SEAT ITSELF, outside lead(): what a leader seat can post to the others
  const crafted = (k, { orders = [], cancels = [], sells = [] }) => {
    const L = leaderOf(k);
    const ids = [...orders, ...cancels.map((c) => toHex(cancelId({ roundId: w.rid, entryId: fromHex(c.entry) }))),
      ...sells.map((s) => toHex(sellId({ roundId: w.rid, entryId: fromHex(s.entry), outcome: s.outcome, price: BigInt(s.price), sharesMsat: BigInt(s.sharesMsat), nonce: BigInt(s.nonce) })))];
    const id = bookBatchId({ roundId: w.rid, k: BigInt(k), orderIds: ids });
    const record = { k: String(k), orders: [...orders].sort(), cancels, sells, leader: toHex(L.round.pubkey) };
    record.leaderSig = toHex(schnorr.sign(id, L.round.identity.secret));
    return { record, id };
  };
  // POSTED TO EVERY SEAT; with the threshold's signatures, its certificate to every seat
  const push = async (record) => {
    const answers = await Promise.all(w.nodes.map(async (d) => {
      const r = await fetch(`${base(d)}/batch?round=${rid}`, { method: 'POST', body: JSON.stringify(record) });
      return r.ok ? { ok: true, ...(await r.json()) } : { ok: false, why: `${r.status} ${(await r.text()).trim()}` };
    }));
    const sigs = answers.filter((a) => a.ok).map((a) => ({ seat: a.seat, signature: a.signature }));
    let certified = 0;
    if (sigs.length >= w.needed) {
      const took = await Promise.all(w.nodes.map((d) => fetch(`${base(d)}/batch-certificate?round=${rid}`, { method: 'POST', body: JSON.stringify({ record, sigs }) }).then((r) => r.ok)));
      certified = took.filter(Boolean).length;
    }
    return { signed: sigs.length, certified, refused: [...new Set(answers.filter((a) => !a.ok).map((a) => a.why.replace(/[0-9a-f]{16}/g, '<id>').replace(/\d+ ms/g, 'N ms').replace(/batch \d+/g, 'batch K')))] };
  };
  const standingOf = (e) => { const s = w.nodes[0].orderBook.standing(w.rid, e.eid); return `${s.filled ? 'filled' : 'unfilled'}${s.cancelled ? ', cancelled' : ''}${s.inPending ? ', waits' : ''}`; };
  const pos = (e) => w.nodes[0].orderBook.ledger(w.rid).positions.get(toHex(e.eid));
  const signSell = (e, sharesMsat, price, nonce) => ({ entry: toHex(e.eid), outcome: YES, price: String(price), sharesMsat: String(sharesMsat), nonce: String(nonce),
    signature: toHex(ed25519.sign(sellId({ roundId: w.rid, entryId: e.eid, outcome: YES, price: BigInt(price), sharesMsat: BigInt(sharesMsat), nonce: BigInt(nonce) }), e.session)) });
  const facts = {};
  try {
    // BATCH 1: A buys Up at 0.60 against B's Down at 0.45 - A fills, B's rest stands; X buys Up at 0.40 and rests, the one bid for Up
    const A = await order(0, YES, 60);
    await order(1, NO, 45);
    const X = await order(2, YES, 40);
    const b1 = await batch();
    assert.equal(b1.certified, true);

    // A. X CANCELLED, UNFILLED - THEN A LOWER BATCH
    await Promise.all(w.nodes.map((d) => fetch(`${base(d)}/cancel?entry=${toHex(X.eid)}`, { method: 'POST', body: ed25519.sign(cancelId({ roundId: w.rid, entryId: X.eid }), X.session) })));
    // one empty slot between batch 1 and the cancel's batch: the lower batch the leader posts later
    { const k = Math.floor(testNow() / B); while (testNow() < (k + 2) * B) await wait(5); }
    const b3 = await batch();
    assert.equal(b3.certified, true);
    assert.equal(b3.cancels, 1);
    const k2 = b3.k - 1;
    assert.ok(k2 > b1.k, 'no batch number between batch 1 and the cancel\'s batch');
    const xBefore = standingOf(X);
    // A's one sell at 0.40, never handed to the seats: the leader of k2 carries it (the player and that seat together)
    for (const d of w.nodes) d.orderBook.lagMs = 60000;          // the bound on k is not what this scenario looks at
    const attackA = crafted(k2, { sells: [signSell(A, 4000n, 40000n, 7n)] });
    const pushedA = await push(attackA.record);
    for (const d of w.nodes) d.orderBook.lagMs = null;
    facts.A = { k1: b1.k, k2, k3: b3.k, xBefore, lowerBatch: pushedA, xAfter: standingOf(X), xCost: String(pos(X).cost) };

    // B. ONE SIGNED SELL, TWICE
    const soldBeforeS1 = pos(A).shares[NO];
    const S1 = signSell(A, 5000n, 70000n, 1n);
    for (const d of w.nodes) assert.equal((await fetch(`${base(d)}/sell?round=${rid}`, { method: 'POST', body: JSON.stringify(S1) })).status, 201);
    const J = await order(5, YES, 75);
    const b4 = await batch();
    assert.equal(b4.certified, true);
    assert.equal(b4.sells, 1);
    const aSold = () => pos(A).shares[NO];
    const soldByS1 = aSold() - soldBeforeS1;
    const J2 = await order(6, YES, 75);
    const k5 = Math.floor(testNow() / B);
    while (testNow() < (k5 + 1) * B + 20) await wait(5);
    const attackB = crafted(k5, { orders: [toHex(J2.eid)], sells: [S1] });
    const pushedB = await push(attackB.record);
    // and its certificate, signed by five seats (an old seat's, or five that agree): taken at a seat?
    const five = w.nodes.slice(0, w.needed).map((d) => ({ seat: toHex(d.round.pubkey), signature: toHex(schnorr.sign(attackB.id, d.round.identity.secret)) }));
    const holder = w.nodes[w.nodes.length - 1];
    const certB = await fetch(`${base(holder)}/batch-certificate?round=${rid}`, { method: 'POST', body: JSON.stringify({ record: attackB.record, sigs: five }) })
      .then(async (r) => `${r.status} ${(await r.text()).trim().replace(/[0-9a-f]{16}/g, '<id>').replace(/batch \d+/g, 'batch K').slice(0, 160)}`);
    facts.B = { k4: b4.k, k5, signedSharesMsat: S1.sharesMsat, soldByS1: String(soldByS1), repeat: pushedB, certificateAtOneSeat: certB,
      soldByS1Now: String(aSold() - soldBeforeS1), soldByS1AtHolder: String(holder.orderBook.ledger(w.rid).positions.get(toHex(A.eid)).shares[NO] - soldBeforeS1) };

    // C. A LATE BET. Z's entry is in before the close, its locks only after it
    const close = Number(w.c.entryCloseMs);
    const lateEntry = async (n) => {
      const z = await order(n, NO, 45, { only: [] });
      const fee = { paymentImage: { kind: 'hash', bytes: sha256(z.entry.feePreimage) }, amountMsat: z.entry.feeMsat, claimPk: z.fields.claimPk, refundPk: z.fields.refundPk, expiration: z.fields.expiration };
      return { ...z, lock: async () => Promise.all(w.nodes.map(async (d) => {
        const s = await fetch(`${base(d)}/lock?entry=${toHex(z.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(z.fields)) });
        const f = await fetch(`${base(d)}/fee-lock?entry=${toHex(z.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(fee)) });
        return `${s.status}/${f.status}`;
      })) };
    };
    // R1 and R2 bid for Up at 0.60 and rest: what a late Down order would fill against
    const R1 = await order(3, YES, 60);
    const R2 = await order(4, YES, 60);
    await batch();
    const Z = await lateEntry(7);
    const Z2 = await lateEntry(8);
    // C1. LOCKED IN THE LAST INTERVAL, AFTER THE CLOSE: the honest leader of the batch whose cutoff follows the close
    const kLast = Math.floor((close + B) / B) - 1;
    skipTo(close + 1);
    const t0 = testNow();
    const zLocks = [...new Set(await Z.lock())];
    const lockedInMs = testNow() - t0;
    while (testNow() < (kLast + 1) * B + 20) await wait(5);
    const last = await leaderOf(kLast).orderBook.lead(w.rid, kLast);
    const zPos = pos(Z);
    // (J2, left unbatched by B, rides in this batch: it was locked before the close)
    facts.C1 = { close, kLast, cutoffAfterCloseMs: (kLast + 1) * B - close, lockedInMs, zLocks, led: last.empty ? 'empty' : { orders: (last.orderIds || []).length, certified: last.certified, why: last.why },
      zInBatch: (last.orderIds || []).includes(toHex(Z.eid)), zFilled: !!zPos && zPos.cost > 0n, r1Cost: String(pos(R1).cost), r2Cost: String(pos(R2).cost) };
    // C2. TEN SECONDS AFTER THE CLOSE, the outcome known: Z2's locks, and a back-dated batch carrying it
    skipTo(close + 10000);
    await Z2.lock();
    const kBack = kLast - 1;
    const attackC = crafted(kBack, { orders: [toHex(Z2.eid)] });
    const pushedC = await push(attackC.record);
    // and with the bound on k lifted: the order itself, locked after the close and after k's cutoff, is refused
    for (const d of w.nodes) d.orderBook.lagMs = 60000;
    const pushedC2 = (await push(crafted(kBack, { orders: [toHex(Z2.eid)] }).record));
    for (const d of w.nodes) d.orderBook.lagMs = null;
    const z2Pos = pos(Z2);
    facts.C2 = { kBack, backDated: pushedC, boundLifted: pushedC2, z2Filled: !!z2Pos && z2Pos.cost > 0n };

    // EVERY SEAT HOLDS THE SAME BOOK
    const books = await Promise.all(w.nodes.map((d) => fetch(`${base(d)}/book?round=${rid}`).then((r) => r.json())));
    facts.booksAgree = books.every((b) => JSON.stringify(b.batches) === JSON.stringify(books[0].batches));
    facts.batchStates = { k2: w.nodes[0].orderBook.batchState?.(w.rid, k2), k3: w.nodes[0].orderBook.batchState?.(w.rid, b3.k), k5: w.nodes[0].orderBook.batchState?.(w.rid, k5) };
    console.log('  MEASURED #1150:', JSON.stringify(facts, null, 1));

    // A: the lower batch is signed by no seat; X stays cancelled, unfilled
    assert.equal(facts.A.xBefore, 'unfilled, cancelled');
    assert.equal(facts.A.lowerBatch.signed, 0, `a seat signed batch ${k2} below the certified ${b3.k}`);
    assert.match(facts.A.lowerBatch.refused.join(' | '), /it signs no batch below one it holds/);
    assert.equal(facts.A.xAfter, 'unfilled, cancelled', 'X filled after every seat said it was cancelled unfilled');
    // B: the repeated sell is signed by no seat, its five-seat certificate is not taken, and A sold 5 sat once
    assert.equal(facts.B.repeat.signed, 0, 'a seat signed a batch carrying a sell another batch carried');
    assert.match(facts.B.repeat.refused.join(' | '), /a signed sell is sold once|is in batch K at this seat/);
    assert.match(facts.B.certificateAtOneSeat, /^409 sell <id> is in batch K at this seat \(CERTIFIED\): it is in one batch only/);
    assert.equal(facts.B.soldByS1, '5000');
    assert.equal(facts.B.soldByS1Now, '5000', 'one signed sell of 5 sat sold more');
    assert.equal(facts.B.soldByS1AtHolder, '5000', 'the seat that was shown the certificate sold the sell twice');
    // C: the late lock is kept (it can come back) but trades in no batch; the back-dated batch is refused for its age, and with the bound
    // lifted for the order's lock time
    assert.deepEqual(facts.C1.zLocks, ['201/201']);
    assert.ok(facts.C1.lockedInMs < facts.C1.cutoffAfterCloseMs, `the late locks took ${facts.C1.lockedInMs} ms: the scenario needs them before batch ${kLast}'s cutoff`);
    assert.equal(facts.C1.zInBatch, false, 'the honest leader batched an order locked after the close');
    assert.equal(facts.C1.zFilled, false, 'an order locked after the close filled');
    assert.equal(facts.C2.backDated.signed, 0, 'a seat signed a back-dated batch ten seconds after the close');
    assert.match(facts.C2.backDated.refused.join(' | '), /a batch is signed no later than N ms after its cutoff/);
    assert.equal(facts.C2.boundLifted.signed, 0);
    assert.match(facts.C2.boundLifted.refused.join(' | '), /was tradable here only N ms after batch K's cutoff/);
    assert.equal(facts.C2.z2Filled, false);
    assert.equal(facts.booksAgree, true, 'two seats hold the book differently');
    assert.deepEqual(facts.batchStates, { k2: 'ABSENT', k3: 'CERTIFIED', k5: 'ABSENT' });
  } finally { await w.close(); }
});
