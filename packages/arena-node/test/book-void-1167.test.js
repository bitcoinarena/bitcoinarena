// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A BATCH DECLINE OR VOID ONLY ON A ROUND SEAT'S SIGNED ASK, PAST THE BATCH'S SIGNING WINDOW (kanban #1167, the state machine audit of
// 2026-11-06, high). Seven seats of one Up/Down market round:
//   A. AN OUTSIDER PRE-DECLINES THE NEXT BATCH: POST /batch-void-ask with an empty body, at every seat, for the batch whose cutoff comes
//      next. Before the fix every seat declined it for good (ABSENT -> DECLINED), and the honest leader's set was signed by none: the
//      orders of that batch did not trade - an outsider doing this each interval stops the book, every order goes back at close.
//   B. ANY ROUND, ANY k: the same ask for a round id no seat holds, and for batch 5 (its cutoff in 1970). Before the fix each wrote a
//      decline row - the table grew without bound.
//   C. A ROUND SEAT WITH THE LEADER'S SET asks before the next batch's cutoff (the set still on its way): refused, so it cannot race it.
//   D. THE REAL VOID STILL WORKS: a leader's set signed by two seats only; the next leader's lead(), at the next cutoff, asks every seat
//      (its own signed ask), four decline, the batch is VOID everywhere, and its order trades in that next batch.
// The facts are printed first (MEASURED), then checked - so the same file run on the old source prints what it did.
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
import { bookBatchId, YES, NO } from '../../arena-protocol/src/order-book.js';
import { UP_DOWN_OUTCOMES } from '../../arena-protocol/src/up-down.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const UPDOWN = testAttestedGame({ name: 'btc-updown-15m-1167', outcomes: [...UP_DOWN_OUTCOMES] });
const NETWORK = TEST_DONATION_SET_KEYS_REGTEST.recipients;
const ROUND = { gameId: UPDOWN.registration.gameId, simCoreHash: b32(0), configHash: b32(0), donationSetId: donationSetId(NETWORK), entryCloseMs: 900000n };
const B = 500;
const player = (n) => ({ ...LOSER, name: `v${n}`, key: b32(0xb0 + n), worldSecret: b32(0) });
const cents = (c) => ({ price: BigInt(c) * 1000n });

test('kanban #1167: a seat declines a batch only on a round seat\'s signed ask, only for a set its leader signed, only past the batch\'s signing window', { timeout: 170000 }, async () => {
  const w = await lockRound({ n: 7, stakeMsat: 10_000n, round: ROUND, endMs: testNow() + 1800000,
    serveOpts: { plugins: [NEXTBLOCK, UPDOWN.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST], orderBatchTimer: false } });
  skipTo(Number(w.c.committeeTimeMs) + 100);
  const rid = toHex(w.rid);
  const base = (d) => `http://127.0.0.1:${d.port}`;
  for (const d of w.nodes) d.orderBook.intervalMs = B;
  const order = (n, outcome, c) => lockAndPlay(w, player(n), { noMarks: true, pick: outcome, order: cents(c) });
  const leaderOf = (k) => w.nodes.find((d) => d.orderBook.leads(w.rid, k));
  const untilCutoff = async (k, extra = 20) => { while (testNow() < (k + 1) * B + extra) await wait(5); };
  const voidAskAll = async (roundHex, k, body = {}) => {
    const got = await Promise.all(w.nodes.map(async (d) => {
      const r = await fetch(`${base(d)}/batch-void-ask?round=${roundHex}&k=${k}`, { method: 'POST', body: JSON.stringify(body) });
      return r.ok ? `${r.status} ${(await r.json()).declined ? 'declined' : 'answered'}` : `${r.status} ${(await r.text()).trim().replace(/\d+ ms/g, 'N ms').replace(/batch \d+/g, 'batch K').slice(0, 140)}`;
    }));
    return [...new Set(got)];
  };
  const declineRows = (roundBytes) => w.nodes.reduce((n, d) => n + d.round.db.prepare('SELECT COUNT(*) AS n FROM market_batch_declines WHERE round_id = ?').get(Buffer.from(roundBytes)).n, 0);
  const states = (k) => [...new Set(w.nodes.map((d) => d.orderBook.batchState(w.rid, k)))];
  const facts = {};
  try {
    // A. AN OUTSIDER PRE-DECLINES THE NEXT BATCH, AN ORDER PAIR IN IT
    const P = await order(0, YES, 60);
    const Q = await order(1, NO, 45);
    const kA = Math.floor(testNow() / B);
    const asked = await voidAskAll(rid, kA);
    const statesAfterAsk = states(kA);
    await untilCutoff(kA);
    const led = await leaderOf(kA).orderBook.lead(w.rid, kA);
    facts.A = { k: kA, outsiderAsk: asked, statesAfterAsk, certified: !!led.certified, why: led.why || null,
      tradedP: !!(led.orderIds || []).includes(toHex(P.eid)), tradedQ: !!(led.orderIds || []).includes(toHex(Q.eid)) };

    // B. A ROUND NO SEAT HOLDS, AND BATCH 5 OF THIS ROUND
    const ghost = new Uint8Array(32).fill(0x67);
    facts.B = { ghostRound: await voidAskAll(toHex(ghost), 1234, {}), ghostRows: declineRows(ghost),
      batch5: await voidAskAll(rid, 5, {}), batch5States: states(5) };

    // D (set up). A LEADER'S SET THAT ONLY TWO SEATS SIGN: it stays pending
    const R = await order(2, YES, 70);
    const S = await order(3, NO, 35);
    const kD = Math.floor(testNow() / B) + 1;
    await untilCutoff(kD);
    const L = leaderOf(kD);
    const ids = [toHex(R.eid), toHex(S.eid)].sort();
    const id = bookBatchId({ roundId: w.rid, k: BigInt(kD), orderIds: ids });
    const record = { k: String(kD), orders: ids, cancels: [], sells: [], leader: toHex(L.round.pubkey), leaderSig: toHex(schnorr.sign(id, L.round.identity.secret)) };
    const two = w.nodes.filter((d) => d !== L).slice(0, 2);
    const signedBy = [L, ...two];
    for (const d of signedBy) {
      const r = await fetch(`${base(d)}/batch?round=${rid}`, { method: 'POST', body: JSON.stringify(record) });
      assert.equal(r.status, 201, await r.text());
    }

    // C. A ROUND SEAT'S SIGNED ASK, INSIDE kD's SIGNING WINDOW: at the seats that did not sign, is it a decline?
    const asker = two[0];
    const ask = asker.orderBook.voidAskFor ? asker.orderBook.voidAskFor(w.rid, kD, record) : {};
    const unsigned = w.nodes.filter((d) => !signedBy.includes(d));
    const early = await Promise.all(unsigned.map(async (d) => {
      const r = await fetch(`${base(d)}/batch-void-ask?round=${rid}&k=${kD}`, { method: 'POST', body: JSON.stringify(ask) });
      return r.ok ? `${r.status} ${(await r.json()).declined ? 'declined' : 'answered'}` : `${r.status} ${(await r.text()).trim().replace(/-?\d+ ms/g, 'N ms').replace(/batch \d+/g, 'batch K').slice(0, 140)}`;
    }));
    // and the same ask with the ids of another set: refused at once
    const forged = ask && ask.ids ? await (async () => {
      const r = await fetch(`${base(unsigned[0])}/batch-void-ask?round=${rid}&k=${kD}`, { method: 'POST', body: JSON.stringify({ ...ask, ids: [ids[0]] }) });
      return `${r.status} ${(await r.text()).trim().slice(0, 60)}`;
    })() : null;
    facts.C = { k: kD, earlyAsk: [...new Set(early)], forged, statesAfter: states(kD) };

    // D. THE NEXT LEADER, at the next cutoff: VOID at once, and R, S trade in that very batch
    const next = leaderOf(kD + 1);
    await untilCutoff(kD + 1);
    const after = await next.orderBook.lead(w.rid, kD + 1);
    facts.D = { kD, kAfter: kD + 1, why: after.why || null, decided: (after.decided || []).map((d) => ({ k: d.k, state: d.state, declined: d.declined })), certified: !!after.certified,
      tradedR: (after.orderIds || []).includes(toHex(R.eid)), statesKD: states(kD) };
    console.log('  MEASURED #1167:', JSON.stringify(facts, null, 1));

    // A: the outsider's ask is refused at every seat; the leader's set is certified and P, Q trade
    assert.ok(facts.A.outsiderAsk.every((x) => /^400 /.test(x)), `an outsider's void ask was answered: ${facts.A.outsiderAsk}`);
    assert.deepEqual(facts.A.statesAfterAsk, ['ABSENT']);
    assert.equal(facts.A.certified, true, `the batch after the outsider's ask was not certified: ${facts.A.why}`);
    assert.equal(facts.A.tradedP && facts.A.tradedQ, true);
    // B: no decline row for a round nobody holds, nor for batch 5
    assert.equal(facts.B.ghostRows, 0, 'a void ask for a round no seat holds wrote decline rows');
    assert.ok(facts.B.ghostRound.every((x) => /^404 /.test(x)), String(facts.B.ghostRound));
    assert.deepEqual(facts.B.batch5States, ['ABSENT']);
    // C: before the next cutoff a round seat's ask declines nothing; another set's ids are refused
    assert.ok(facts.C.earlyAsk.every((x) => /^409 .*declines it only from the next cutoff/.test(x)), String(facts.C.earlyAsk));
    assert.match(String(facts.C.forged), /^400 those ids are not the set/);
    assert.deepEqual(facts.C.statesAfter.sort(), ['ABSENT', 'SIGNED']);
    // D: void at the next cutoff, everywhere, and its orders trade in that batch
    assert.deepEqual(facts.D.decided.map((d) => [Number(d.k), d.state]), [[kD, 'VOID']]);
    assert.ok(facts.D.decided[0].declined >= w.nodes.length - w.needed + 1);
    assert.deepEqual(facts.D.statesKD, ['VOID']);
    assert.equal(facts.D.certified, true);
    assert.equal(facts.D.tradedR, true, 'the void batch\'s order did not trade in the next batch');
  } finally { await w.close(); }
});
