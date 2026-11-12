// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 v1 refute 41 skeptic 3 (#1526, after 40cd22c05): THE CAPS ARE PER ORDER, THE RESTING BOOK IS NOT CAPPED AT ALL.
// 07d81d630 bounds a batch at MAX_UNBATCHED_SELLS (16) sells of one order per seat and MAX_PROPOSAL_SELLS (256) per seat's proposal:
// sixteen small filled orders - sixteen tiny locks - fill the whole 256 at every seat, 1,792 sells a batch on 7 seats, 3,584 a second.
// A 1-msat sell at 99c never crosses and rests until the close. 40cd22c05 keeps the parsed certified batches, but the ledger with the
// next batch on top (lead(), each follower's #check) replays every certified batch through bookLedger, and the kept ledger is rebuilt
// whole after each certificate. Three minutes of that flood (645,120 resting) are measured here against the 500 ms batch interval.
// The flood's certified records are written straight into the store with one fixed signature per sell: a certified record's sells are
// not verified on replay (40cd22c05 #sellParsed), so the replay costs exactly what the 645,120 real signed sells cost.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { b32, LOSER } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { testAttestedGame } from './plugins/sign.js';
import { TEST_DONATION_SET_KEYS_REGTEST } from '../../arena-protocol/src/test-donation-set-keys-regtest.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { sellId, YES, NO } from '../../arena-protocol/src/order-book.js';
import { UP_DOWN_OUTCOMES } from '../../arena-protocol/src/up-down.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { MAX_UNBATCHED_SELLS, MAX_PROPOSAL_SELLS } from '../src/order-batch.js';

const UPDOWN = testAttestedGame({ name: 'btc-updown-15m-wf1489-v1r41s3', outcomes: [...UP_DOWN_OUTCOMES] });
const NETWORK = TEST_DONATION_SET_KEYS_REGTEST.recipients;
const ROUND = { gameId: UPDOWN.registration.gameId, simCoreHash: b32(0), configHash: b32(0), donationSetId: donationSetId(NETWORK), entryCloseMs: 900000n };
const B = 500, SEATS = 7, ORDERS = MAX_PROPOSAL_SELLS / MAX_UNBATCHED_SELLS;

test('wf1489 v1 refute 41 s3-2: three minutes of 16 orders x 16 sells per seat per batch make each batch\'s ledger work exceed the interval', { timeout: 290000 }, async () => {
  const w = await lockRound({ n: SEATS, stakeMsat: 100_000_000n, round: ROUND, endMs: testNow() + 1800000,
    serveOpts: { plugins: [NEXTBLOCK, UPDOWN.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST], orderBatchTimer: false } });
  skipTo(Number(w.c.committeeTimeMs) + 100);
  for (const d of w.nodes) d.orderBook.intervalMs = B;
  try {
    const zs = [], ys = [];
    for (let i = 0; i < ORDERS; i++) {
      zs.push(await lockAndPlay(w, { ...LOSER, name: `z${i}`, key: b32(0x80 + i), worldSecret: b32(2 * i) }, { noMarks: true, pick: YES, order: { price: 40000n }, only: [] }));
      ys.push(await lockAndPlay(w, { ...LOSER, name: `y${i}`, key: b32(0xc0 + i), worldSecret: b32(2 * i + 1) }, { noMarks: true, pick: NO, order: { price: 60000n }, only: [] }));
    }
    const ob = w.nodes[0].orderBook, db = ob.db, R = Buffer.from(w.rid);
    const put = db.prepare('INSERT INTO market_batches (round_id, k, batch_id, record, own_sig, certificate, stored_ms) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const putOrder = db.prepare("INSERT OR REPLACE INTO market_orders (order_id, round_id, body, received_ms, batch) VALUES (?, ?, '', ?, ?)");
    const k0 = 1, all = [...zs, ...ys].map((x) => toHex(x.eid));
    for (const h of all) putOrder.run(h, R, 0, k0);
    const FIXED = 'ab'.repeat(64);
    const sell = (zh, nonce) => ({ entry: zh, outcome: YES, price: '99000', sharesMsat: '1', nonce: String(nonce), signature: FIXED });
    const NB = Math.floor(180000 / B);
    db.exec('BEGIN');
    put.run(R, k0, String(k0).padStart(64, '0'), JSON.stringify({ k: String(k0), orders: all, cancels: [], sells: [], leader: '', leaderSig: '' }), null, '[]', 0);
    let n = 0;
    for (let k = k0 + 1; k <= k0 + NB; k++) {
      const sells = [];
      for (const z of zs) { const zh = toHex(z.eid); for (let i = 0; i < SEATS * MAX_UNBATCHED_SELLS; i++, n++) sells.push(sell(zh, n)); }
      put.run(R, k, String(k).padStart(64, '0'), JSON.stringify({ k: String(k), orders: [], cancels: [], sells, leader: '', leaderSig: '' }), null, '[]', 0);
    }
    db.exec('COMMIT');
    let t0 = Date.now();
    const L = ob.ledger(w.rid);
    const coldMs = Date.now() - t0;
    assert.equal(L.ok, true, L.why);
    const filled = [...L.positions.values()].filter((p) => p.shares[0] > 0n || p.shares[1] > 0n).length;
    // the next batch on top, one really signed sell of the first order (lead(), each follower's #check)
    const z0 = zs[0], nonce = BigInt(n + 1);
    const real = { entry: toHex(z0.eid), outcome: YES, price: '99000', sharesMsat: '1', nonce: String(nonce),
      signature: toHex(ed25519.sign(sellId({ roundId: w.rid, entryId: z0.eid, outcome: YES, price: 99000n, sharesMsat: 1n, nonce }), z0.session)) };
    const extra = { k: String(k0 + NB + 1), orders: [], cancels: [], sells: [real], leader: '', leaderSig: '' };
    const onTop = [];
    for (let i = 0; i < 3; i++) { t0 = Date.now(); const X = ob.ledger(w.rid, extra); onTop.push(Date.now() - t0); assert.equal(X.ok, true, X.why); }
    put.run(R, k0 + NB + 1, String(k0 + NB + 1).padStart(64, '0'), JSON.stringify(extra), null, '[]', 0);
    t0 = Date.now();
    const L2 = ob.ledger(w.rid);
    const rebuildMs = Date.now() - t0;
    assert.equal(L2.ok, true, L2.why);
    const perBatchMs = Math.min(...onTop) + rebuildMs;
    console.log('MEASURED', JSON.stringify({ orders: ORDERS, filled, batches: NB, perBatch: ORDERS * SEATS * MAX_UNBATCHED_SELLS, posted: n,
      resting: L.resting.sells.length, refused: L.refused.length, coldMs, onTopMs: onTop, rebuildMs, perBatchMs, intervalMs: B }));
    assert.ok(L.resting.sells.length > 600000, 'the sells did not rest (setup)');
    assert.ok(perBatchMs < B, `each batch costs a seat ${perBatchMs} ms of event loop (ledger on top ${Math.min(...onTop)} ms + kept ledger rebuilt ${rebuildMs} ms) over ${L.resting.sells.length} resting sells: the ${B} ms interval cannot be kept`);
  } finally { await w.close?.(); }
});
