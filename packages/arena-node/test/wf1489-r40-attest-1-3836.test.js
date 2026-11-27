// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 r40-attest-1 (bypass of #3294): THE KEPT LEDGER IS STILL EVICTED BY A STRANGER'S GET /book OF OTHER ROUNDS THAT HOLD ONE
// CERTIFIED BATCH. #3294 keeps an EMPTY round (no certified batch) out of #parsedBook, but every round that ever traded takes a slot on
// a public read - GET /market-rounds lists up to 200 such rounds of the last two days, so 64 GET /book of them still push the busy round
// out and its next ledger() replays the whole book from batch 0. (Original a5-1-1 text follows.)
// audit attest a5-1-1: THE KEPT LEDGER OF #2086 IS EVICTED BY A STRANGER'S GET /book OF OTHER ROUNDS. order-batch.js keeps the parsed
// certified book and its BookLedgerState for the REPLAY_ROUNDS_MAX (64) rounds read last (#parsedBook, an LRU), and EVERY read of a market
// round - GET /book of any held Up/Down round, even an empty one of the series' next hours - puts that round in front. 64 public GET /book
// of other held market rounds push the busy round out, and its next ledger() (lead, a follower's #check, POST /sell, GET /book,
// settlement) parses every certified record again and replays the whole book from batch 0 - the cost #2086 took off every batch.
// The safe behaviour asserted: after the strangers' reads, the busy round's ledger() costs what a warm one costs (it is not rebuilt).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { b32, LOSER } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { testAttestedGame } from './plugins/sign.js';
import { TEST_DONATION_SET_KEYS_REGTEST } from '../../arena-protocol/src/test-donation-set-keys-regtest.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { YES, NO } from '../../arena-protocol/src/order-book.js';
import { UP_DOWN_OUTCOMES } from '../../arena-protocol/src/up-down.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { MAX_UNBATCHED_SELLS } from '../src/order-batch.js';

const UPDOWN = testAttestedGame({ name: 'btc-updown-15m-wf1489-r40-attest-1', outcomes: [...UP_DOWN_OUTCOMES] });
const NETWORK = TEST_DONATION_SET_KEYS_REGTEST.recipients;
const ROUND = { gameId: UPDOWN.registration.gameId, simCoreHash: b32(0), configHash: b32(0), donationSetId: donationSetId(NETWORK), entryCloseMs: 900000n };
const B = 500, SEATS = 7;

test('wf1489 r40-attest-1: 64 public GET /book of other market rounds that each hold one certified batch make the busy round\'s next ledger() replay the whole book', { timeout: 240000 }, async () => {
  const w = await lockRound({ n: SEATS, stakeMsat: 100_000_000n, round: ROUND, endMs: testNow() + 1800000,
    serveOpts: { plugins: [NEXTBLOCK, UPDOWN.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST], orderBatchTimer: false } });
  skipTo(Number(w.c.committeeTimeMs) + 100);
  for (const d of w.nodes) d.orderBook.intervalMs = B;
  try {
    const z = await lockAndPlay(w, { ...LOSER, name: 'zz', key: b32(0xee), worldSecret: b32(0) }, { noMarks: true, pick: YES, order: { price: 40000n }, only: [] });
    const y = await lockAndPlay(w, { ...LOSER, name: 'yy', key: b32(0xef), worldSecret: b32(1) }, { noMarks: true, pick: NO, order: { price: 60000n }, only: [] });
    const seat = w.nodes[0], ob = seat.orderBook, db = ob.db, R = Buffer.from(w.rid);
    // THE BUSY ROUND: what the #2086 flood (MAX_UNBATCHED_SELLS never-crossing 1-msat sells of one filled order per seat per batch)
    // leaves after a few minutes - certified records written straight into the store (a certified record's sells are not verified
    // on replay, #sellParsed, so a fixed signature costs the replay what a real one does)
    const put = db.prepare('INSERT INTO market_batches (round_id, k, batch_id, record, own_sig, certificate, stored_ms) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const putOrder = db.prepare("INSERT OR REPLACE INTO market_orders (order_id, round_id, body, received_ms, batch) VALUES (?, ?, '', ?, ?)");
    const zh = toHex(z.eid), yh = toHex(y.eid), k0 = 1;
    putOrder.run(zh, R, 0, k0); putOrder.run(yh, R, 0, k0);
    const FIXED = 'ab'.repeat(64);
    const NB = Math.floor(240000 / B);
    db.exec('BEGIN');
    put.run(R, k0, String(k0).padStart(64, '0'), JSON.stringify({ k: String(k0), orders: [zh, yh], cancels: [], sells: [], leader: '', leaderSig: '' }), null, '[]', 0);
    let n = 0;
    for (let k = k0 + 1; k <= k0 + NB; k++) {
      const sells = [];
      for (let i = 0; i < SEATS * MAX_UNBATCHED_SELLS; i++, n++) sells.push({ entry: zh, outcome: YES, price: '99000', sharesMsat: '1', nonce: String(n), signature: FIXED });
      put.run(R, k, String(k).padStart(64, '0'), JSON.stringify({ k: String(k), orders: [], cancels: [], sells, leader: '', leaderSig: '' }), null, '[]', 0);
    }
    db.exec('COMMIT');
    // THE SEAT'S OTHER HELD MARKET ROUNDS: the series' coming windows a seat lists (each a round of the same market, empty)
    const row = db.prepare('SELECT contract, opened_ms FROM rounds WHERE round_id = ?').get(R);
    const others = [];
    const putRound = db.prepare('INSERT INTO rounds (round_id, contract, state, opened_ms) VALUES (?, ?, 0, ?)');
    // each held a certified batch once (a past round that traded: one certified record) - what GET /market-rounds names
    db.exec('BEGIN');
    for (let i = 0; i < 64; i++) {
      const id = randomBytes(32); putRound.run(id, row.contract, row.opened_ms); others.push(toHex(id));
      put.run(id, 1, String(1).padStart(64, '0'), JSON.stringify({ k: '1', orders: [], cancels: [], sells: [], leader: '', leaderSig: '' }), null, '[]', 0);
    }
    db.exec('COMMIT');

    // warm: the kept ledger built once, then read
    let t0 = Date.now();
    const L0 = ob.ledger(w.rid);
    const firstMs = Date.now() - t0;
    assert.equal(L0.ok, true, L0.why);
    assert.ok(L0.resting.sells.length > 20000, 'the sells did not rest (setup)');
    t0 = Date.now();
    assert.equal(ob.ledger(w.rid).ok, true);
    const warmMs = Date.now() - t0;

    // A STRANGER: one public GET /book of each of 64 other held market rounds
    const base = `http://127.0.0.1:${seat.port}`;
    const statuses = [];
    for (const id of others) { const r = await fetch(`${base}/book?round=${id}`); statuses.push(r.status); await r.arrayBuffer(); }
    assert.ok(statuses.every((s) => s === 200), `GET /book answered ${[...new Set(statuses)].join(', ')} (setup)`);

    t0 = Date.now();
    const L1 = ob.ledger(w.rid);
    const afterMs = Date.now() - t0;
    console.log('MEASURED', JSON.stringify({ batches: NB, resting: L0.resting.sells.length, firstBuildMs: firstMs, warmMs, afterStrangerMs: afterMs }));
    assert.equal(L1.ok, true, L1.why);
    assert.ok(afterMs <= Math.max(50, warmMs * 10),
      `after 64 public GET /book of other rounds the busy round's ledger() took ${afterMs} ms (warm ${warmMs} ms, first build ${firstMs} ms): its kept ledger was evicted and replayed from batch 0`);
  } finally { await w.close?.(); }
});
