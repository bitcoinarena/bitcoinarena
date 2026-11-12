// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1892 (#1489 refute 2 of #1485/#1742, feedback #010): the check right before a head-to-head lock reads the close on the seats' clock, from what
// each seat said in its handout 201 (x-entry-close-in-ms), and the smaller of that and the player's own clock must leave the lead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { postHandout, seatCloseLeftMs, seatClockAheadMs, h2hLockRefusal } from '../src/join.js';

const answer = (left) => async () => new Response(new Uint8Array(32), { status: 201, headers: left === undefined ? {} : { 'x-entry-close-in-ms': String(left) } });

test('#1892 postHandout keeps the earliest close the seats said; the lock check takes the seats\' clock when it is ahead of the player\'s', async () => {
  const now = Date.now();
  let i = 0;
  const lefts = [5000, 3000];
  const put = await postHandout({ body: new Uint8Array(1) }, ['http://a', 'http://b'], { needed: 2, fetcher: async (u, o) => answer(lefts[i++])(u, o) });
  assert.equal(put.ok, true);
  const left = seatCloseLeftMs(put);
  assert.ok(left <= 3000 && left > 2500, `the earliest seat's close: ${left}`);
  // the player's clock is slow by 60 s: its own reading says 63 s are left, the seats' 3 s
  const close = now + 3000 + 60000;
  assert.ok(seatClockAheadMs(put, close) >= 59000);
  assert.equal(h2hLockRefusal({ put, entryCloseMs: close, leadMs: 2000 }), null, 'with 3 s left on the seats a 2 s lead locks');
  assert.match(h2hLockRefusal({ put, entryCloseMs: close, leadMs: 4000 }), /seats' clock.*nothing was locked/);
  // the funding ran 2 s after the handout: 1 s is left on the seats
  assert.match(h2hLockRefusal({ put, entryCloseMs: close, leadMs: 2000, now: Date.now() + 2000 }), /nothing was locked/);
});

test('#1892 a seat that does not say (an older build) leaves the player\'s clock as before', async () => {
  const put = await postHandout({ body: new Uint8Array(1) }, ['http://a'], { needed: 1, fetcher: answer(undefined) });
  assert.equal(put.ok, true);
  assert.equal(put.seatCloseAtMs, null);
  assert.equal(seatCloseLeftMs(put), null);
  assert.equal(seatClockAheadMs(put, Date.now()), 0);
  assert.equal(h2hLockRefusal({ put, entryCloseMs: Date.now() + 10000, leadMs: 4000 }), null);
  assert.match(h2hLockRefusal({ put, entryCloseMs: Date.now() + 3000, leadMs: 4000 }), /player's clock/);
  assert.match(h2hLockRefusal({ put: null, entryCloseMs: Date.now() + 3000, leadMs: 4000 }), /nothing was locked/);
});
