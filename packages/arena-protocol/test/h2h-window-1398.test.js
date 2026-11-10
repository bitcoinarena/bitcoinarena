// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// §13A's one exception (RULED 2026-11-10, kanban #1398): a head-to-head round's objection window is 60 s (5 s on a regtest); replayed games keep 600 s.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OBJECTION_WINDOW_MS, OBJECTION_WINDOW_H2H_MS, OBJECTION_WINDOW_H2H_REGTEST_MS, objectionWindowAllowed, objectionWindowFits } from '../src/constants.js';
import { windowsOf } from '../src/window.js';

test('the windows a contract may name: 600 s, 60 s, 5 s - nothing else', () => {
  assert.equal(OBJECTION_WINDOW_H2H_MS, 60_000n);
  assert.equal(OBJECTION_WINDOW_H2H_REGTEST_MS, 5_000n);
  for (const w of [OBJECTION_WINDOW_MS, OBJECTION_WINDOW_H2H_MS, OBJECTION_WINDOW_H2H_REGTEST_MS]) assert.equal(objectionWindowAllowed(w), true, String(w));
  for (const w of [0n, 1n, 59_999n, 60_001n, 300_000n, 599_999n, 600_001n, 21_600_000n, 600000, null, undefined]) assert.equal(objectionWindowAllowed(w), false, String(w));
});

test('which window a round may name is its game\'s: replayed 600 s only; head-to-head 60 s (regtest 5 s) or 600 s', () => {
  assert.equal(objectionWindowFits(600_000n, { headToHead: false }).ok, true);
  assert.equal(objectionWindowFits(60_000n, { headToHead: false }).ok, false, 'a replayed game never gets the short window');
  assert.equal(objectionWindowFits(5_000n, { headToHead: false, regtest: true }).ok, false);
  assert.equal(objectionWindowFits(60_000n, { headToHead: true }).ok, true);
  assert.equal(objectionWindowFits(600_000n, { headToHead: true }).ok, true, 'rounds published before the ruling stand');
  assert.equal(objectionWindowFits(5_000n, { headToHead: true }).ok, false, 'the regtest window on another network');
  assert.equal(objectionWindowFits(5_000n, { headToHead: true, regtest: true }).ok, true);
  assert.equal(objectionWindowFits(60_000n, { headToHead: true, regtest: true }).ok, false, 'a regtest head-to-head round names 5 s or 600 s');
  assert.match(objectionWindowFits(60_000n, { headToHead: false }).why, /replayed game/);
});

test('the windows follow the contract: a 60 s round is FINAL-signable 65 s after its end, a 600 s round 605 s after', () => {
  const base = { startTimeMs: 1_000_000n, entryCloseMs: 1_000_000n, blockTicks: 1, startDeadlineTicks: 1 };
  const end = (w) => windowsOf({ ...base, objectionWindowMs: w });
  const a = end(60_000n), b = end(600_000n);
  assert.equal(a.closeMs - a.openMs, 60_000n);
  assert.equal(a.finalAfterMs - a.openMs, 65_000n);
  assert.equal(b.closeMs - b.openMs, 600_000n);
  assert.equal(end(123n).closeMs - end(123n).openMs, 600_000n, 'a window no round may name counts as 600 s');
});
