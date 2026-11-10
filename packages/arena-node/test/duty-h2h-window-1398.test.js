// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1398 (§13A, RULED 2026-11-10): the day's duty node posts an RPS day with the head-to-head 60 s window - the template would carry 600 s on
// for good - and every other app keeps what its template carries; ARENA_H2H_WINDOW=0 keeps 600 s. The day's fields take the caller's extra fields.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('a seat\'s duty poster names 60 s on an RPS day only, and createDayDuty puts the extra fields on the day\'s rounds', () => {
  const poster = readFileSync(new URL('../src/duty-poster.js', import.meta.url), 'utf8');
  assert.ok(poster.includes("extraFields: (g) => (g === 'rps' && env.ARENA_H2H_WINDOW !== '0' ? { objectionWindowMs: 60_000n } : {}),"));
  const day = readFileSync(new URL('../src/duty-day.js', import.meta.url), 'utf8');
  assert.ok(day.includes('extraFields = () => ({}) } = o;'), 'none by default');
  assert.ok(day.includes('fields: { ...base.fields, ...extraFields(game), censusHeight: base.censusHeight }'), 'over the template, under the census height');
});
