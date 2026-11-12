// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 v1 refute 41 skeptic 2 (#1526, after 07d81d630): A REFUSED POST /sell IS STILL A FULL REPLAY, WITH NO BOUND.
// ask('sell') checks tradable and the 16-waiting cap, then #sellBacked runs this.ledger() - every certified batch from 0, every sell
// through #sellStands - and only then refuses a sell its entry cannot back (here: outcome NO of an order that holds YES). A refused
// sell is not stored, so the 16-waiting cap never counts it: the holder of one tradable order replays the whole book at a seat once
// per POST, as fast as it can post. On the book two minutes of the still-allowed flood leave (26,880 resting sells):
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NO } from '../../arena-protocol/src/order-book.js';
import { floodedBook, B } from './wf1489-v1-refute-41-s2-fixture.js';

test('wf1489 v1 refute 41 s2-2: unstored refused sells each cost the seat a whole-book replay', { timeout: 170000 }, async () => {
  const f = await floodedBook({ batches: Math.floor(120000 / B) });
  try {
    const ob = f.seat.orderBook;
    const warm = ob.ledger(f.w.rid);   // the cache is warm: the attacker pays nothing a restart would
    assert.equal(warm.ok, true, warm.why);
    const POSTS = 20;
    const t0 = Date.now();
    const answers = [];
    for (let i = 0; i < POSTS; i++) answers.push(ob.ask(f.w.rid, 'sell', f.sell(NO, 900000000 + i)));
    const ms = Date.now() - t0;
    console.log('MEASURED', JSON.stringify({ resting: warm.resting.sells.length, posts: POSTS, ms, perPostMs: ms / POSTS, first: answers[0], stored: answers.filter((a) => a.ok).length }));
    assert.ok(answers.every((a) => !a.ok), 'the NO sells were taken (setup)');
    assert.ok(ms < 1000, `${POSTS} refused POST /sell of one order held the seat's event loop ${ms} ms (${(ms / POSTS).toFixed(0)} ms each, none stored, none counted)`);
  } finally { await f.w.close?.(); }
});
