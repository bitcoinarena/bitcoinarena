// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 r2 entry 1: A STRANGER'S LOCKLESS ORDER FLOODS THE BOOK WITH SELLS AND STALLS EVERY LEADER.
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

const UPDOWN = testAttestedGame({ name: 'btc-updown-15m-wf1489-r2e1', outcomes: [...UP_DOWN_OUTCOMES] });
const NETWORK = TEST_DONATION_SET_KEYS_REGTEST.recipients;
const ROUND = { gameId: UPDOWN.registration.gameId, simCoreHash: b32(0), configHash: b32(0), donationSetId: donationSetId(NETWORK), entryCloseMs: 900000n };
const B = 500;
const N = 1500;

test('wf1489 r2 entry 1: sells of a lockless order are refused and a sell flood does not stall lead()', { timeout: 170000 }, async () => {
  const w = await lockRound({ n: 7, stakeMsat: 10_000n, round: ROUND, endMs: testNow() + 1800000,
    serveOpts: { plugins: [NEXTBLOCK, UPDOWN.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST], orderBatchTimer: false } });
  skipTo(Number(w.c.committeeTimeMs) + 100);
  const rid = toHex(w.rid);
  for (const d of w.nodes) d.orderBook.intervalMs = B;
  try {
    // THE STRANGER'S ORDER: an entry with a limit price, handed to no seat's lock door (no stake, no fee - nothing locked)
    const z = await lockAndPlay(w, { ...LOSER, name: 'zz', key: b32(0xee), worldSecret: b32(0) }, { noMarks: true, pick: YES, order: { price: 40000n }, only: [] });
    const sell = (nonce) => ({ entry: toHex(z.eid), outcome: YES, price: '50000', sharesMsat: '1000', nonce: String(nonce),
      signature: toHex(ed25519.sign(sellId({ roundId: w.rid, entryId: z.eid, outcome: YES, price: 50000n, sharesMsat: 1000n, nonce: BigInt(nonce) }), z.session)) });
    const viaDoor = await fetch(`http://127.0.0.1:${w.nodes[0].port}/sell?round=${rid}`, { method: 'POST', body: JSON.stringify(sell(0)) });
    const doorStatus = viaDoor.status;
    // the rest straight into each seat's book (what N POSTs would store)
    const sells = [];
    for (let i = 1; i < N; i++) sells.push(sell(i));
    let kept = 0;
    for (const d of w.nodes) for (const s of sells) if (d.orderBook.ask(w.rid, 'sell', s).ok) kept++;
    const k = Math.floor(testNow() / B);
    while (testNow() < (k + 1) * B + 20) await wait(5);
    const leader = w.nodes.find((d) => d.orderBook.leads(w.rid, k));
    const t0 = Date.now();
    const got = await leader.orderBook.lead(w.rid, k);
    const leadMs = Date.now() - t0;
    console.log('MEASURED', JSON.stringify({ doorStatus, kept, of: sells.length * w.nodes.length, leadOk: got.ok, leadMs, proposalSells: leader.orderBook.proposal(w.rid, k + 1).sells.length }));
    assert.notEqual(doorStatus, 201, 'POST /sell of an order whose locks no seat verified is taken');
    assert.equal(kept, 0, `${kept} sells of a lockless order kept across the seats`);
    assert.ok(leadMs < 3000, `one lead() over the flood took ${leadMs} ms of the seat's event loop`);
  } finally { await w.close?.(); }
});
