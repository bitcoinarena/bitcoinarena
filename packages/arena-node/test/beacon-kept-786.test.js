// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SAME BEACON AGAIN WRITES NOTHING (kanban #786, measured 2026-10-30 03:2xZ on second-host seat 3: 136 INSERT OR REPLACE INTO round_beacons a
// minute - after each restart every held round's beacon was replaced by the same row). Round.putBeacon writes only a new or a changed row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';

test('a beacon is written once; the same one again writes nothing; a different one replaces it', () => {
  const round = new Round(openStore(':memory:'));
  const id = new Uint8Array(32).fill(7), a = new Uint8Array(32).fill(1), b = new Uint8Array(32).fill(2);
  let writes = 0;
  const prepare = round.db.prepare.bind(round.db);
  round.db.prepare = (sql) => { const st = prepare(sql); if (/round_beacons/.test(sql) && /INSERT/.test(sql)) { const run = st.run.bind(st); st.run = (...x) => { const o = run(...x); writes += Number(o.changes); return o; }; } return st; };
  assert.equal(round.putBeacon(id, { hash: a, height: 10, timeMs: 5n }), true);
  assert.equal(round.putBeacon(id, { hash: a, height: 10, timeMs: 5n }), false, 'the same beacon: nothing written');
  assert.equal(writes, 1, 'one row change for two puts of one beacon');
  assert.equal(round.putBeacon(id, { hash: b, height: 11, timeMs: 6n }), true, 'another block: replaced');
  const kept = round.beaconOf(id);
  assert.deepEqual([Buffer.from(kept.hash).toString('hex'), kept.height, kept.timeMs], [Buffer.from(b).toString('hex'), 11, 6n]);
});
