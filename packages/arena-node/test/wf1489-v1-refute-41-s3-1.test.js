// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 v1 refute 41 skeptic 3 (#1526, after 40cd22c05): THE RESTING FLOOD STILL GROWS WITHOUT BOUND, AND EVERY BATCH REPLAYS ALL OF IT.
// 40cd22c05 keeps the parsed certified batches and the ledger of the certified batches alone - but a ledger "with one more batch on top"
// (lead(), every follower's #check in accept()) runs bookLedger over every certified batch again, and the kept ledger is rebuilt whole
// each time the certified set changes - that is, after every batch. 07d81d630 still lets 16 sells per seat per 500 ms batch through
// (MAX_UNBATCHED_SELLS waiting, then they rest: a never-crossing 1-msat sell rests until the close), so resting sells grow by 224 a second
// for the whole market. Ten minutes into a 15-minute market (134,400 resting) each seat's per-batch book work - one ledger with the
// next batch on top, one rebuilt kept ledger after its certificate - is measured here against the 500 ms batch interval.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { floodedBook, SEATS, PER, B } from './wf1489-v1-refute-41-s2-fixture.js';
import { YES } from '../../arena-protocol/src/order-book.js';

test('wf1489 v1 refute 41 s3-1: ten minutes of the 16-per-seat sell flood make each batch\'s ledger work exceed the batch interval', { timeout: 290000 }, async () => {
  const NB = Math.floor(600000 / B);
  const f = await floodedBook({ batches: NB });
  try {
    const ob = f.seat.orderBook, rid = f.w.rid;
    let t0 = Date.now();
    const L = ob.ledger(rid);
    const coldMs = Date.now() - t0;
    assert.equal(L.ok, true, L.why);
    // THE NEXT BATCH ON TOP (what lead() and each follower's #check run once per batch): one fresh sell
    const extra = { k: String(f.lastK + 1), orders: [], cancels: [], sells: [f.sell(YES, f.posted + 1)], leader: '', leaderSig: '' };
    const onTop = [];
    for (let i = 0; i < 3; i++) { t0 = Date.now(); const X = ob.ledger(rid, extra); onTop.push(Date.now() - t0); assert.equal(X.ok, true, X.why); }
    // ITS CERTIFICATE ARRIVES: the certified set changed, the kept ledger is rebuilt (the next POST /sell, GET /book, standing read it)
    const db = ob.db, R = Buffer.from(rid);
    db.prepare('INSERT INTO market_batches (round_id, k, batch_id, record, own_sig, certificate, stored_ms) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(R, f.lastK + 1, String(f.lastK + 1).padStart(64, '0'), JSON.stringify(extra), null, '[]', 0);
    t0 = Date.now();
    const L2 = ob.ledger(rid);
    const rebuildMs = Date.now() - t0;
    assert.equal(L2.ok, true, L2.why);
    const perBatchMs = Math.min(...onTop) + rebuildMs;
    console.log('MEASURED', JSON.stringify({ batches: NB, perBatch: SEATS * PER, posted: f.posted, signMs: f.signMs, resting: L.resting.sells.length,
      coldMs, onTopMs: onTop, rebuildMs, perBatchMs, intervalMs: B }));
    assert.ok(L.resting.sells.length > 100000, 'the sells did not rest (setup)');
    assert.ok(perBatchMs < B, `each batch costs a seat ${perBatchMs} ms of event loop (ledger on top ${Math.min(...onTop)} ms + kept ledger rebuilt ${rebuildMs} ms) over ${L.resting.sells.length} resting sells: the ${B} ms interval cannot be kept`);
  } finally { await f.w.close?.(); }
});
