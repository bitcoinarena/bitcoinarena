// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2901: the per-round lookups go by index, never a full scan (seat 1 measured ~1.5 % idle before, ~65 % after)
import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';

test('a seat store looks up handouts, stake locks, fee locks and batches by index (kanban #2901)', () => {
  const db = openStore(':memory:');
  new Round(db);
  const plan = (sql, n) => db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...Array(n).fill(Buffer.alloc(32))).map((r) => r.detail).join(' | ');
  for (const [sql, n] of [
    ['SELECT COUNT(*) AS n FROM handouts WHERE round_id = ?', 1],
    ['SELECT fields FROM stake_locks WHERE round_id = ?', 1],
    ['SELECT entry_id FROM stake_locks WHERE outpoint = ?', 1],
    ['SELECT entry_id FROM fee_locks WHERE outpoint = ?', 1],
    ['SELECT bytes FROM batches WHERE entry_id = ? ORDER BY seq DESC LIMIT 1', 1],
  ]) assert.doesNotMatch(plan(sql, n), /^SCAN /, `${sql} scans its table: ${plan(sql, n)}`);
  assert.match(plan('SELECT round_id FROM rounds ORDER BY opened_ms DESC LIMIT 60', 0), /rounds_by_opened/);
});
