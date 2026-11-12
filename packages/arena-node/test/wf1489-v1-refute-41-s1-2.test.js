// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 v1 refute 41-2 (#1526): ONE SEAT HANDS THE LEADER THE FLOOD THE DOOR NOW REFUSES.
// POST /sell (OrderBook.ask) checks only that the sell is signed by the session key of an order entry this seat holds. It does not
// ask that the order is in the book (its locks verified, tradable) and keeps every fresh nonce as a new market_book_events row, with no
// bound per entry. A stranger posts one order entry (no lock, no sat), signs N sells with nonces 0..N-1, and each seat keeps them all.
// Every batch proposal then carries all N, and the leader's lead() filters the refused sells with
// `record.sells.filter((s) => !L.refused.some((r) => r.id === this.#sellStands(s).id))` - O(N^2) #sellStands calls (each a DB read,
// an entry decode, a hash), synchronous, every batch interval, at every seat in turn.
// SAFE: a sell of an order this seat holds no verified locks for is refused, and one lead() over such a flood stays fast.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { b32, LOSER, wait } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { testAttestedGame } from './plugins/sign.js';
import { TEST_DONATION_SET_KEYS_REGTEST } from '../../arena-protocol/src/test-donation-set-keys-regtest.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { sellId, YES } from '../../arena-protocol/src/order-book.js';
import { UP_DOWN_OUTCOMES } from '../../arena-protocol/src/up-down.js';
import { toHex } from '../../arena-protocol/src/hash.js';

// The fix checks tradability and MAX_UNBATCHED_SELLS only in ask() (POST /sell). lead() takes every sell of every seat's GET
// /batch-proposal that is signed by an entry it holds - no tradable check, no bound per order, no bound per proposal - and checks
// each one's Ed25519 signature on its event loop (fresh nonces miss the verified cache). One seat (or a stranger it serves as a
// relay) lists N sells of a lockless order; every leader of every batch verifies all N before it can sign.
const UPDOWN = testAttestedGame({ name: 'btc-updown-15m-wf1489-v1r41', outcomes: [...UP_DOWN_OUTCOMES] });
const NETWORK = TEST_DONATION_SET_KEYS_REGTEST.recipients;
const ROUND = { gameId: UPDOWN.registration.gameId, simCoreHash: b32(0), configHash: b32(0), donationSetId: donationSetId(NETWORK), entryCloseMs: 900000n };
const B = 500;
const N = 6000;

test('wf1489 v1 refute 41-2: a seat\'s proposal carries a lockless order\'s sell flood and the leader verifies it all', { timeout: 170000 }, async () => {
  const w = await lockRound({ n: 7, stakeMsat: 10_000n, round: ROUND, endMs: testNow() + 1800000,
    serveOpts: { plugins: [NEXTBLOCK, UPDOWN.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST], orderBatchTimer: false } });
  skipTo(Number(w.c.committeeTimeMs) + 100);
  try {
    for (const d of w.nodes) d.orderBook.intervalMs = B;
    const z = await lockAndPlay(w, { ...LOSER, name: 'zz', key: b32(0xee), worldSecret: b32(0) }, { noMarks: true, pick: YES, order: { price: 40000n }, only: [] });
    const sell = (nonce) => ({ entry: toHex(z.eid), outcome: YES, price: '50000', sharesMsat: '1000', nonce: String(nonce),
      signature: toHex(ed25519.sign(sellId({ roundId: w.rid, entryId: z.eid, outcome: YES, price: 50000n, sharesMsat: 1000n, nonce: BigInt(nonce) }), z.session)) });
    const flood = [];
    for (let i = 0; i < N; i++) flood.push(sell(1000000 + i));
    const door = w.nodes[0].orderBook.ask(w.rid, 'sell', flood[0]);
    const k = Math.floor(testNow() / B);
    while (testNow() < (k + 1) * B + 20) await wait(5);
    const leader = w.nodes.find((d) => d.orderBook.leads(w.rid, k));
    const bad = w.nodes.find((d) => d !== leader);
    const real = bad.orderBook.proposal.bind(bad.orderBook);
    bad.orderBook.proposal = (rid, kk) => { const p = real(rid, kk); return { ...p, sells: [...p.sells, ...flood] }; };
    const t0 = Date.now();
    const got = await leader.orderBook.lead(w.rid, k);
    const leadMs = Date.now() - t0;
    console.log('MEASURED', JSON.stringify({ doorOk: door.ok, doorWhy: door.why, flood: N, leadOk: got.ok, leadMs, sells: got.sells }));
    assert.equal(door.ok, false, 'the door took a lockless sell (setup)');
    assert.ok(leadMs < 1000, `one seat's proposal of ${N} sells of an order no seat verified the locks of held the leader's lead() ${leadMs} ms`);
  } finally { await w.close?.(); }
});
