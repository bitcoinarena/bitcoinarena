// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A SEASON READ TAKES ITS ROUNDS BY THE ENTRIES' INDEX, NOT BY SCANNING EVERY ROUND (kanban #3562, feedback #407/#408, the outage of
// 2026-11-24 00:00-00:40Z): seasonRounds asked "every round that has an entry" as a scan of the whole rounds table with an EXISTS per row.
// Measured on a copy of seat 1's store (3 GB, 673,190 rounds, 2,358 with entries): 920 MB read per pass, 3.3 s cold on the Beelink's disk;
// GET /season and /season-rounds each run it every 5 minutes per game set, and in the outage they held the seats' loop 28-46 s at a time
// (seats 1-3 not answering, Up/Down's 00:15 committee not seated). Driven from entries_by_round the same rows read 23 MB in 0.26 s.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';
import { SEASON_ROUNDS_SQL } from '../src/season-read.js';

const OLD = 'SELECT r.round_id, r.contract FROM rounds r WHERE EXISTS (SELECT 1 FROM entries e WHERE e.round_id = r.round_id)';

test('the season read does not scan the rounds table', () => {
  const db = openStore(':memory:');
  const plan = db.prepare('EXPLAIN QUERY PLAN ' + SEASON_ROUNDS_SQL).all().map((x) => String(x.detail));
  assert.ok(!plan.some((d) => /^SCAN (r|rounds)\b/.test(d)), 'the plan scans every round: ' + plan.join(' | '));
  assert.ok(plan.some((d) => /entries_by_round/.test(d)), 'the plan does not use the entries index: ' + plan.join(' | '));
});

test('it reads the same rounds in the same order as the scan did', () => {
  const db = openStore(':memory:');
  const id = (i) => Buffer.from(String(i).padStart(32, 'x'));
  // ids inserted out of id order, so the rowid order (the scan's) is not the id order
  const order = [7, 3, 11, 1, 9, 5, 2, 8, 12, 4, 10, 6];
  for (const i of order) db.prepare('INSERT INTO rounds (round_id, contract, state, opened_ms) VALUES (?, ?, 0, ?)').run(id(i), Buffer.from([i]), i);
  let n = 0;
  for (const i of [9, 3, 12, 7, 2]) for (let k = 0; k < (i % 3) + 1; k++)
    db.prepare('INSERT INTO entries (entry_id, round_id, contract, joined_ms) VALUES (?, ?, ?, ?)').run(Buffer.from(`e${n++}`.padStart(32, '0')), id(i), Buffer.from([0]), n);
  const ids = (rows) => rows.map((r) => Buffer.from(r.round_id).toString());
  const was = ids(db.prepare(OLD).all()), now = ids(db.prepare(SEASON_ROUNDS_SQL).all());
  assert.equal(was.length, 5);
  assert.deepEqual(now, was);
});
