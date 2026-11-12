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

// kanban #1489 refute of #1519/#1697/#1886 (skeptic 3): the DECIDED branch covers a leader that signed two sets when the threshold signed
// one of them. A leader of batch k1 that signs two sets and splits the six honest seats 3/3 gets NEITHER set certified (4 of 5 each,
// its own signature on both) and no seat declines (every honest seat signed one set). #decide finds no threshold, no certificate of
// k1 and 0 declines: k1 stays PENDING at every leader, the honest seats hold it signed and sign no later batch (#signGuard) - one
// dishonest seat freezes the book for good, the effect #1519 closed for a forged pending item.

const UPDOWN = testAttestedGame({ name: 'btc-updown-15m', outcomes: [...UP_DOWN_OUTCOMES] });
const NETWORK = TEST_DONATION_SET_KEYS_REGTEST.recipients;
const ROUND = { gameId: UPDOWN.registration.gameId, simCoreHash: b32(0), configHash: b32(0), donationSetId: donationSetId(NETWORK), entryCloseMs: 900000n };
const player = (n) => ({ ...LOSER, name: `wf${n}`, key: b32(0x60 + n), worldSecret: b32(0) });

// kanban #2026: the equivocation void (applyVoid `sets`) is no back door. A set whose ids hash under another k, or a split where a set
// still has too few seats that can never sign it, is refused; the genuine split is taken.
test('a void backed by signed sets is taken only when no set of k can reach the threshold', async () => {
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
    const orders = bad.orderBook.proposal(w.rid, k1).orders;
    const idOf = (k, ids) => toHex(bookBatchId({ roundId: w.rid, k: BigInt(k), orderIds: ids }));
    const sig = (d, id) => ({ seat: toHex(d.orderBook.round.pubkey), signature: toHex(schnorr.sign(Buffer.from(id, 'hex'), d.orderBook.round.identity.secret)) });
    const honest = w.nodes.filter((d) => d !== bad);
    const idsA = [...orders], idsB = [orders[0]];
    const A = idOf(k1, idsA), Bid = idOf(k1, idsB);
    // the honest seats' signatures are what an honest seat would hand out; three on each set, the leader on both
    const setA = { batchId: A, ids: idsA, sigs: [sig(bad, A), ...honest.slice(0, 3).map((d) => sig(d, A))] };
    const setB = { batchId: Bid, ids: idsB, sigs: [sig(bad, Bid), ...honest.slice(3).map((d) => sig(d, Bid))] };
    const judge = honest[0].orderBook;
    // 1. B's ids hash under k1 + 1, not k1: that set is ignored, A alone has 0 seats that cannot sign it
    const otherK = { ...setB, batchId: idOf(k1 + 1, idsB), sigs: [sig(bad, idOf(k1 + 1, idsB)), ...honest.slice(3).map((d) => sig(d, idOf(k1 + 1, idsB)))] };
    let r = judge.applyVoid(w.rid, { k: String(k1), declines: [], sets: [setA, otherK] });
    assert.equal(r.ok, false, 'a set of another batch voided k1');
    // 2. a 4/2 split: A has only 2 seats that can never sign it (n - needed + 1 = 3 needed) - not void
    const setB2 = { ...setB, sigs: [sig(bad, Bid), ...honest.slice(4).map((d) => sig(d, Bid))] };
    const setA4 = { ...setA, sigs: [sig(bad, A), ...honest.slice(0, 4).map((d) => sig(d, A))] };
    r = judge.applyVoid(w.rid, { k: String(k1), declines: [], sets: [setA4, setB2] });
    assert.equal(r.ok, false, 'a split where A could still be certified voided k1');
    assert.match(r.why, /could still sign it/);
    // 3. the 3/3 split: void, at every seat it is handed to
    r = judge.applyVoid(w.rid, { k: String(k1), declines: [], sets: [setA, setB] });
    assert.equal(r.ok, true, r.why);
    assert.equal(judge.batchState(w.rid, k1), 'VOID');
  } finally { await w.close(); }
});
