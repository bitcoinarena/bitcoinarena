// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SCORE'S UNIT IS ONE NUMBER IN TWO PLACES (2026-09-25: the core's score is the product 1000 · E · T · C,
// kept as an integer count of 1e-5 points). The core forms it (rules/score.js) and the protocol compares it with a round's
// min_score in points (constants.js); if the two scales ever differ, a qualifier is decided on the wrong floor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCORE_SCALE as CORE, FACTOR_SCALE } from '../src/rules/score.js';
import { SCORE_SCALE as PROTOCOL } from 'arena-sdk/constants';

test('the core and the protocol keep the score in the same unit', () => {
  assert.equal(CORE, PROTOCOL);
  assert.equal(FACTOR_SCALE, 100000, 'the factors are on the five-decimal grid the card prints');
});
