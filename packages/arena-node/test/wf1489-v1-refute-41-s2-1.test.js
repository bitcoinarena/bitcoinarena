// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 v1 refute 41 skeptic 2 (#1526, after 07d81d630): A SEAT THAT RESTARTS (or whose verified cache rolled over) RE-VERIFIES
// EVERY RESTING SELL ON EACH ledger() CALL. 07d81d630 made bookLedger fast, but OrderBook.ledger() still hands every sell of every
// certified batch through #sellStands, whose verified-sell cache lives in memory (empty after a restart; verified.js keeps 16384).
// Two minutes of the flood 07d81d630 still lets through (16 sells per seat per 500 ms batch, one real order) leave 26,880 resting
// sells; the first ledger() after a restart - the first POST /sell, lead(), accept(), GET /book, settlement - checks 26,880 Ed25519
// signatures on the event loop. Past 65,536 resting (about 5 minutes of a 15-minute market) the FIFO cache thrashes on every replay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OrderBook } from '../src/order-batch.js';
import { floodedBook, SEATS, PER, B } from './wf1489-v1-refute-41-s2-fixture.js';

test('wf1489 v1 refute 41 s2-1: after a restart, one ledger() over two minutes of resting tiny sells stalls the seat', { timeout: 170000 }, async () => {
  const NB = Math.floor(120000 / B);
  const f = await floodedBook({ batches: NB });
  try {
    const d = f.seat;
    // THE RESTART: a new OrderBook over the same database (what server.js builds at start), nothing verified yet
    const fresh = new OrderBook(d.orderBook.round, { plugins: d.orderBook.plugins, intervalMs: B, now: d.orderBook.now, feesFor: d.orderBook.feesFor });
    let t0 = Date.now();
    const L = fresh.ledger(f.w.rid);
    const coldMs = Date.now() - t0;
    t0 = Date.now();
    const L2 = fresh.ledger(f.w.rid);
    const warmMs = Date.now() - t0;
    console.log('MEASURED', JSON.stringify({ batches: NB, perBatch: SEATS * PER, posted: f.posted, signMs: f.signMs, ok: L.ok, why: L.why,
      resting: L.ok ? L.resting.sells.length : null, refused: L.ok ? L.refused.length : null, coldMs, warmMs, warmOk: L2.ok }));
    assert.equal(L.ok, true, L.why);
    assert.ok(L.resting.sells.length > 20000, 'the sells did not rest (setup)');
    assert.ok(coldMs < 1000, `the first ledger() after a restart over ${L.resting.sells.length} resting sells took ${coldMs} ms on the event loop`);
  } finally { await f.w.close?.(); }
});
