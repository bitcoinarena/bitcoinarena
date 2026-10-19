// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE REPLAY BUDGET (§34): max_players_per_round = measured speed x 600 s window / T_run; the speed is a median of measured
// replays, never assumed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maxPlayersPerRound, medianSpeed } from '../src/replay-budget.js';

test('the spec\'s own numbers: 82 s runs at 30x hold 219 players, at 60x 439; no measurement, no number', () => {
  assert.equal(maxPlayersPerRound({ speedX: 30, runMs: 82000 }), 219);
  assert.equal(maxPlayersPerRound({ speedX: 60, runMs: 82000 }), 439);
  assert.equal(maxPlayersPerRound({ speedX: null, runMs: 82000 }), 0);
  assert.equal(medianSpeed([{ wallMs: 1000, gameMs: 30000 }, { wallMs: 1000, gameMs: 60000 }, { wallMs: 1000, gameMs: 10000 }]), 30);
  assert.equal(medianSpeed([{ wallMs: 1000, gameMs: 30000 }, { wallMs: 1000, gameMs: 50000 }]), 40);
  assert.equal(medianSpeed([]), null);
});
