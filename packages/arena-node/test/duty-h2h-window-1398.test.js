// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1398 (§13A, RULED 2026-11-10): the day's duty node posts an RPS day with the head-to-head 60 s window - the template would carry 600 s on
// for good - and every other app keeps what its template carries; ARENA_H2H_WINDOW=0 keeps 600 s. The day's fields take the caller's extra fields.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('a seat\'s duty poster names the short window on an RPS day only with ARENA_H2H_WINDOW=1, and createDayDuty puts the extra fields on the day\'s rounds', () => {
  const poster = readFileSync(new URL('../src/duty-poster.js', import.meta.url), 'utf8');
  // #1399: off unless ARENA_H2H_WINDOW=1 (Daniel: other nodes must audit a 60 s result first), 600 s named outright when off, 5 s on a regtest
  assert.ok(poster.includes("extraFields: (g) => (g !== 'rps' ? {} : env.ARENA_H2H_WINDOW !== '1' ? { objectionWindowMs: OBJECTION_WINDOW_MS }"));
  assert.ok(poster.includes(": { objectionWindowMs: nid === toHex(NETWORK_ID_REGTEST) ? OBJECTION_WINDOW_H2H_REGTEST_MS : OBJECTION_WINDOW_H2H_MS }),"));
  const day = readFileSync(new URL('../src/duty-day.js', import.meta.url), 'utf8');
  assert.ok(day.includes('extraFields = () => ({}) } = o;'), 'none by default');
  assert.ok(day.includes('fields: { ...base.fields, ...extraFields(game), censusHeight: base.censusHeight }'), 'over the template, under the census height');
});

// audit 5 (#1399): a seat's /standing names the round's own window close - a head-to-head round's 60 s, not a fixed 600 s
test('standing reads the window close and the FINAL-after instant from the round\'s own contract', () => {
  const src = readFileSync(new URL('../src/standing.js', import.meta.url), 'utf8');
  assert.ok(src.includes('return windowsOf(contract).closeMs;'));
  assert.ok(src.includes('return windowsOf(contract).finalAfterMs;'));
});
