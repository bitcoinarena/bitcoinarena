// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OBJECTION WINDOW IS EXACTLY 600 000 ms (§13A, WINDOW-10-SPEC, RULED 2026-10-01 09:40).
//
// "A Round Contract whose objection_window_W is not exactly 600000 ms is invalid: a node refuses to open it, list it or
// take an entry for it." Until that ruling the field was contract-defined - any positive window up to a 6-hour cap
// opened - and this file pinned that; the reference ten minutes is now the only window, and 0, 599999 and 600001 are
// refused alike, by name. (The node's open, list and entry doors are measured in window-10.test.js.)
//
// §13A'S ONE EXCEPTION (RULED 2026-11-10, commit 9b6ded8f9, kanban #1398): "a head-to-head round's result is a pure function of two
// signed commitments and two signed reveals, so its window is 60 s (objection_window_h2h; regtest 5 s) ... replayed games keep 600 s."
// So a contract may name 600 s, 60 s or 5 s (objectionWindowAllowed); which of them its round may name is its game's kind, judged where
// the game is known (objectionWindowFits, round.js). Every other window is still refused by name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roundWindowsAreValid } from '../../arena-protocol/src/contracts.js';
import { objectionWindowFits } from '../../arena-protocol/src/constants.js';
import { readFileSync } from 'node:fs';

// The other windows valid, so only the objection window can be what refuses.
const round = (objectionWindowMs) => ({
  committeeTimeMs: 0n, startTimeMs: 600000n, entryCloseMs: 700000n, objectionWindowMs,
});

test('600000 ms - ten minutes - opens', () => {
  const r = roundWindowsAreValid(round(600000n));
  assert.equal(r.ok, true, r.why);
});

test('a head-to-head round\'s 60 s (5 s on a regtest) opens as a contract, and only a head-to-head game may name it (kanban #1398)', () => {
  for (const w of [60000n, 5000n]) assert.equal(roundWindowsAreValid(round(w)).ok, true, `${w}ms`);
  assert.equal(objectionWindowFits(60000n, { headToHead: false }).ok, false, 'a replayed game takes 60 s');
  assert.equal(objectionWindowFits(60000n, { headToHead: true }).ok, true);
  assert.equal(objectionWindowFits(5000n, { headToHead: true }).ok, false, 'a 5 s window off a regtest');
  assert.equal(objectionWindowFits(5000n, { headToHead: true, regtest: true }).ok, true);
  assert.equal(objectionWindowFits(600000n, { headToHead: true }).ok, true, 'a head-to-head round published before the ruling');
});

test('every other window is refused - one millisecond either side, a second, a minute and a millisecond, an hour, six hours - naming the 600000 ms rule', () => {
  for (const w of [1n, 1000n, 4999n, 5001n, 59999n, 60001n, 599999n, 600001n, 3600000n, 21_600_000n, 86_400_000n]) {
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
