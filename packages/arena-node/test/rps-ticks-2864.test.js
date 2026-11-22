// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #2864 (the owner 2026-11-15: "8s runden und dann 5-10s aufdecken"): an RPS day's rounds end 10 s after their entry close (was 20 s) - the
// reveal deadline and the earliest settlement. A head-to-head round has no run: its blockTicks are not checked against a core, only that the
// start deadline is shorter than the run (contracts.js) and that its end lies within the game's reveal window (manifest: 120 s).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RPS_TICKS } from '../src/duty-poster.js';
import { roundEndMs } from '../../arena-protocol/src/first-mark.js';
import { H2H_REVEAL_MIN_MS } from '../../arena-protocol/src/manifest.js';
import { H2H_REVEAL_HOLD_MS } from '../src/server.js';
import { LOCK_SET_WINDOW_MS } from '../../arena-protocol/src/lock-set.js';

test('#2864 an RPS round ends 10.015 s after its entry close: the least head-to-head reveal window, room for the lock set and the reveal', () => {
  assert.deepEqual({ ...RPS_TICKS }, { blockTicks: 301, startDeadlineTicks: 150 });
  assert.ok(RPS_TICKS.startDeadlineTicks >= 1 && RPS_TICKS.startDeadlineTicks < RPS_TICKS.blockTicks, 'a valid contract: the start deadline is shorter than the run');
  const close = 1_800_000_000_000n;
  const end = roundEndMs({ entryCloseMs: close, ...RPS_TICKS });
  assert.equal(end - close, 10_015n);
  assert.ok(roundEndMs({ entryCloseMs: close, blockTicks: 300, startDeadlineTicks: 150 }) - close < H2H_REVEAL_MIN_MS, '300 ticks would be 9,998 ms: refused by round.js');
  assert.ok(end - close >= H2H_REVEAL_MIN_MS, 'not below the protocol\'s least reveal window');
  // what has to fit before the deadline: the lock set (certified inside its window), the moves served after the hold, the reveals posted -
  // measured live 2026-11-15 18:35-18:40Z: both moves shown 3.6-5.0 s after the close
  assert.ok(Number(LOCK_SET_WINDOW_MS) + H2H_REVEAL_HOLD_MS + 5000 <= Number(end - close), 'window + hold + the measured 5 s of reveals fit in 10 s');
  // the old timing, for the record
  assert.equal(roundEndMs({ entryCloseMs: close, blockTicks: 600, startDeadlineTicks: 300 }) - close, 19_996n);
});
