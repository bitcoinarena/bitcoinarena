// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3904 (2.0): no round index reads the whole rounds table in one statement - the heartbeat agent, the stall book and the
// presence book did, as the 1.9 seating agent did (869,467 contracts at once on a copy of a testnet4 seat).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { roundsAfter, ROUNDS_PAGE } from '../src/rounds-paged.js';

test('roundsAfter answers every row after the rowid in order, never more than a page per statement', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE rounds (round_id BLOB, contract BLOB)');
  const put = db.prepare('INSERT INTO rounds (round_id, contract) VALUES (?, ?)');
  const n = 2 * ROUNDS_PAGE + 5;
  for (let i = 0; i < n; i++) put.run(new Uint8Array([i & 255, i >> 8]), new Uint8Array(8));
  let most = 0; const prepare = db.prepare.bind(db);
  db.prepare = (sql) => { const st = prepare(sql); const all = st.all.bind(st); st.all = (...a) => { const r = all(...a); most = Math.max(most, r.length); return r; }; return st; };
  const ids = [...roundsAfter(db, 'rowid AS n, round_id', 3)].map((r) => r.n);
  assert.equal(ids.length, n - 3);
  assert.deepEqual(ids.slice(0, 3), [4, 5, 6]);
  assert.ok(ids.every((x, i) => i === 0 || x === ids[i - 1] + 1), 'out of order');
  assert.ok(most <= ROUNDS_PAGE, `one statement held ${most} rounds`);
});

test('no src module reads every round contract after a rowid in one .all() (kanban #3904)', () => {
  const dir = new URL('../src/', import.meta.url);
  const bad = readdirSync(dir).filter((f) => f.endsWith('.js'))
    .filter((f) => /contract FROM rounds WHERE rowid > \? ORDER BY rowid'\)\.all\(/.test(readFileSync(new URL(f, dir), 'utf8')));
  assert.deepEqual(bad, []);
});
