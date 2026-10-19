// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OBJECTION WINDOW IS EXACTLY 600 000 ms (§13A, WINDOW-10-SPEC, RULED 2026-10-01 09:40).
//
// "A Round Contract whose objection_window_W is not exactly 600000 ms is invalid: a node refuses to open it, list it or
// take an entry for it." Until that ruling the field was contract-defined - any positive window up to a 6-hour cap
// opened - and this file pinned that; the reference ten minutes is now the only window, and 0, 599999 and 600001 are
// refused alike, by name. (The node's open, list and entry doors are measured in window-10.test.js.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roundWindowsAreValid } from '../../arena-protocol/src/contracts.js';
import { readFileSync } from 'node:fs';

// The other windows valid, so only the objection window can be what refuses.
const round = (objectionWindowMs) => ({
  committeeTimeMs: 0n, startTimeMs: 600000n, entryCloseMs: 700000n, objectionWindowMs,
});

test('600000 ms - ten minutes - opens', () => {
  const r = roundWindowsAreValid(round(600000n));
  assert.equal(r.ok, true, r.why);
});

test('every other window is refused - one millisecond either side, a second, an hour, six hours - naming the 600000 ms rule', () => {
  for (const w of [1n, 1000n, 60000n, 599999n, 600001n, 3600000n, 21_600_000n, 86_400_000n]) {
    const r = roundWindowsAreValid(round(w));
    assert.equal(r.ok, false, `a ${w}ms window opened`);
    assert.match(r.why, new RegExp(`^that round's objection window is ${w}ms: the objection window is exactly 600000ms `));
  }
});

test('A ZERO WINDOW IS REFUSED, and the refusal says why it matters', () => {
  const r = roundWindowsAreValid(round(0n));
  assert.equal(r.ok, false, 'a round opened with no result window at all');
  assert.match(r.why, /objection window is 0ms: the objection window is exactly 600000ms/);
});

test('a negative window is refused too', () => {
  assert.equal(roundWindowsAreValid(round(-1n)).ok, false);
  assert.equal(roundWindowsAreValid(round(-600000n)).ok, false);
});

test('a contract that names no window at all is refused rather than defaulted', () => {
  // Defaulting would be inventing the number the spec declines to fix.
  for (const missing of [undefined, null, 600000, '600000']) {
    const r = roundWindowsAreValid(round(missing));
    assert.equal(r.ok, false, `objectionWindowMs ${String(missing)} was accepted`);
    assert.match(r.why, /names no objection window/);
  }
});

test('the other window rules still refuse what they always did', () => {
  // The new check must not shadow the ones beside it: a round that starts too soon is still refused, and it
  // is refused for its own reason rather than for the window.
  const tooSoon = { committeeTimeMs: 0n, startTimeMs: 1n, entryCloseMs: 700000n, objectionWindowMs: 600000n };
  const r = roundWindowsAreValid(tooSoon);
  assert.equal(r.ok, false);
  assert.match(r.why, /leaving 1ms to enter/);
});

test('THE CALL SITE ITSELF: delete it from Round.open and this goes red', () => {
  // A bound nothing asks is not a bound. Round.open must call roundWindowsAreValid and throw on its answer,
  // before the contract is stored.
  const src = readFileSync(new URL('../src/round.js', import.meta.url), 'utf8');
  assert.match(src, /import \{[^}]*roundWindowsAreValid[^}]*\} from '\.\.\/\.\.\/arena-protocol\/src\/contracts\.js'/,
    'round.js no longer imports the window check');
  assert.match(src, /const windows = roundWindowsAreValid\(contract\);/,
    'round.js no longer calls the window check - a round could name a zero result window');
  assert.match(src, /if \(!windows\.ok\) throw new Error\(windows\.why\);/,
    'round.js reads the window check but no longer refuses on it');
  const call = src.indexOf('roundWindowsAreValid(contract)');
  const stored = src.indexOf('INSERT OR IGNORE INTO rounds');
  assert.ok(call > 0 && stored > call, 'the window check is asked after the round is already stored');
});
