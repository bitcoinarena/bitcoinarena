// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A NODE THAT KEEPS MISSING ITS SEATS IS WARNED (§5A.3): drawn and not seated, three times in a row, newest first - and the
// serving = false update is offered. A round it was not drawn for is no seating it missed; one it sat ends the count.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { missedInARow, seatingWarning } from '../src/seatings.js';

test('missed seatings count in a row from the newest, skip rounds not drawn for, and warn from three', () => {
  const r = (atMs, drawn, seated) => ({ atMs, drawn, seated });
  assert.equal(missedInARow([r(1, true, true), r(2, true, false), r(3, false, false), r(4, true, false)]), 2);
  assert.equal(missedInARow([r(4, true, false), r(1, true, false), r(3, true, false), r(2, true, true)]), 2, 'ordered by time, not by the list');
  assert.equal(missedInARow([r(1, true, false), r(2, true, false), r(3, true, false)]), 3);
  assert.equal(seatingWarning(2), null);
  const w = seatingWarning(3);
  assert.match(w.says, /drawn and not seated 3 times in a row/); assert.match(w.says, /serving = false/); assert.match(w.update, /ARENA_ADVERT_SERVING=false/);
});

test('a reserve that was present missed nothing: it ends the count, and 28 present reserve sits warn of nothing (testnet4 2026-10-14)', () => {
  const r = (atMs, drawn, seated, present) => ({ atMs, drawn, seated, present });
  assert.equal(missedInARow(Array.from({ length: 28 }, (_, i) => r(i, true, false, true))), 0, 'macOS node 5: present every time, a reserve every time');
  assert.equal(seatingWarning(missedInARow(Array.from({ length: 28 }, (_, i) => r(i, true, false, true)))), null);
  // absent three times since it was last present: warned
  assert.equal(missedInARow([r(1, true, false, true), r(2, true, false, false), r(3, true, false, false), r(4, true, false, false)]), 3);
});

test('a table\'s rounds are one seating: missed once, not once per round (kanban #809: "Your node missed 42 draws in a row")', async () => {
  const { oncePerSeating, missedInARow } = await import('../src/seatings.js');
  // 42 later rounds of one table this node was drawn for and not seated in, then a round it sat
  const rows = Array.from({ length: 42 }, (_, i) => ({ round: `t${i}`, seating: 'tableA', atMs: 1000 + i, drawn: true, seated: false, present: false }))
    .concat([{ round: 'r1', atMs: 500, drawn: true, seated: true, present: true }]);
  assert.equal(missedInARow(rows), 42, 'counted per round, as before');
  const once = oncePerSeating(rows);
  assert.equal(once.length, 2);
  assert.equal(missedInARow(once), 1, 'the table counted once');
  assert.deepEqual(once.map((r) => r.round), ['t41', 'r1'], 'the newest row of the table kept');
});
