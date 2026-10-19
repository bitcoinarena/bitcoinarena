// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// ROCK PAPER SCISSORS' DECIDE ADAPTER: what beats what, for two players and for more.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DECIDE, MOVES } from '../plugin/decide.js';

const d = (...moves) => DECIDE.decide(moves.map((move, i) => ({ key: `p${i}`, move })));

test('two players: paper beats rock, scissors beat paper, rock beats scissors, the same move is a draw', () => {
  assert.deepEqual(MOVES, ['rock', 'paper', 'scissors']);
  assert.deepEqual(d(1, 0), { p0: 'WIN', p1: 'LOSS' });
  assert.deepEqual(d(2, 1), { p0: 'WIN', p1: 'LOSS' });
  assert.deepEqual(d(0, 2), { p0: 'WIN', p1: 'LOSS' });
  assert.deepEqual(d(0, 1), { p0: 'LOSS', p1: 'WIN' });
  for (const m of [0, 1, 2]) assert.deepEqual(d(m, m), { p0: 'DRAW', p1: 'DRAW' });
});

test('three players: all three moves shown, or all the same, is a draw; two moves shown - the beating one wins', () => {
  assert.deepEqual(d(0, 1, 2), { p0: 'DRAW', p1: 'DRAW', p2: 'DRAW' });
  assert.deepEqual(d(2, 2, 2), { p0: 'DRAW', p1: 'DRAW', p2: 'DRAW' });
  assert.deepEqual(d(0, 0, 2), { p0: 'WIN', p1: 'WIN', p2: 'LOSS' });
  assert.throws(() => d(0, 3), /0, 1 or 2/);
});
