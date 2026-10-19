// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ROUNDS ARE LISTED FROM AN INDEX, NOT SORTED (2026-10-02, the the test host's load): openRounds and finishedRounds sorted
// every held contract in a temporary B-tree, which spilled to disk on every sweep of ~2,950 rounds (~1.6 MB/s per idle
// testnet4 seat). Their query plans now read an index and use no temporary B-tree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';

test('openRounds and finishedRounds read the rounds index and sort nothing', () => {
  const db = openStore(':memory:');
  const plan = (sql, ...a) => db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...a).map((r) => r.detail).join(' | ');
  const open = plan('SELECT round_id, contract, opened_ms FROM rounds WHERE state = ? ORDER BY opened_ms', 0);
  const closed = plan('SELECT round_id, contract, closed_ms FROM rounds WHERE state = ? ORDER BY closed_ms DESC LIMIT ?', 1, 200);
  console.log('  FACTS:', JSON.stringify({ open, closed }));
  assert.match(open, /USING INDEX rounds_by_state_opened/);
  assert.doesNotMatch(open, /TEMP B-TREE/);
  assert.match(closed, /USING INDEX rounds_by_state_closed/);
  assert.doesNotMatch(closed, /TEMP B-TREE/);
});
