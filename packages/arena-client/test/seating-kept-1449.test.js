// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// §5A.7, RULED 2026-11-11 (kanban #1449): a table's seating is read once, not once per round. A seat's answer per (seat, table, role) stands for the
// table's later rounds while the page's own draw is the same seats and the answer is under seating_keep_ms (60 s); a different draw, the age, or a read
// of every seat (after a seat differed) asks again. A failed read is never kept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keptSeating, keepSeatingAnswer, forgetSeatings, SEATING_KEEP_MS } from '../src/committee.js';

const KEY = 'https://g1|aa|settlement', DRAW = '01,02,03', CERT = { status: 200, ok: true, body: '{"cert":"x","index":0}' };

test('a kept answer stands for the same table, role and draw under seating_keep_ms (#1449)', () => {
  forgetSeatings();
  assert.equal(SEATING_KEEP_MS, 60000);
  assert.equal(keptSeating(KEY, DRAW, { now: 1000 }), null, 'nothing kept: asked');
  keepSeatingAnswer(KEY, DRAW, CERT, { now: 1000 });
  assert.deepEqual(keptSeating(KEY, DRAW, { now: 1000 + 59999 }), CERT);
});

test('a different draw, the age passing, or a read of every seat asks again (#1449)', () => {
  forgetSeatings();
  keepSeatingAnswer(KEY, DRAW, CERT, { now: 1000 });
  assert.equal(keptSeating(KEY, '01,02,04', { now: 2000 }), null, 'the draw changed');
  assert.equal(keptSeating(KEY, DRAW, { now: 1000 + 60000 }), null, '60 s passed');
  assert.equal(keptSeating(KEY, DRAW, { now: 2000, every: true }), null, 'a seat differed: every seat is read again');
  assert.equal(keptSeating('https://g1|bb|settlement', DRAW, { now: 2000 }), null, 'another table');
  assert.equal(keptSeating('https://g1|aa|game', DRAW, { now: 2000 }), null, 'another role');
});

test('only an answer is kept: a 404 "no seating certificate" is, a failed read or another status is not (#1449)', () => {
  forgetSeatings();
  keepSeatingAnswer(KEY, DRAW, { status: 404, ok: false, body: 'no seating certificate' }, { now: 1000 });
  assert.equal(keptSeating(KEY, DRAW, { now: 1500 }).status, 404);
  forgetSeatings();
  keepSeatingAnswer(KEY, DRAW, null, { now: 1000 });
  keepSeatingAnswer(KEY, DRAW, { status: 503, ok: false, body: 'busy' }, { now: 1000 });
  assert.equal(keptSeating(KEY, DRAW, { now: 1500 }), null);
});
