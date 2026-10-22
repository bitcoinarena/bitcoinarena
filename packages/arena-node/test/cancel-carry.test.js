// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// HOW OFTEN A SEAT PULLS THE OTHER SEATS' CANCELS (kanban #576): only for a round with an entry here, at most once per 30 s each.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cancelCarryDue, CANCEL_CARRY_MS } from '../src/settlement.js';

test('a round with no entry here pulls no cancels; one with entries pulls once per 30 s', () => {
  const m = new Map();
  assert.equal(cancelCarryDue(m, 'r1', 1000, 0), false, 'no entry: nothing a cancel could change');
  assert.equal(cancelCarryDue(m, 'r1', 1000, 2), true);
  assert.equal(cancelCarryDue(m, 'r1', 1000 + CANCEL_CARRY_MS - 1, 2), false);
  assert.equal(cancelCarryDue(m, 'r2', 1001, 1), true, 'each round on its own clock');
  assert.equal(cancelCarryDue(m, 'r1', 1000 + CANCEL_CARRY_MS, 2), true);
});
