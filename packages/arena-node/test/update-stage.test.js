// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// UPDATES STAGED PER FEDERATION (kanban #1093 part 3): at most f guardians of one federation on a new release without a healthy hour.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stageDecision, faultsOf, STAGE_HEALTHY_MS } from '../src/update-stage.js';

const key = (i) => String(i).padStart(2, '0').repeat(32);
const SEVEN = [1, 2, 3, 4, 5, 6, 7].map(key);
const NOW = 1_800_000_000_000, V = '2026.2.0', OLD = '2026.1.9.24';
const fresh = { version: V, startedAtMs: NOW - 60_000, healthy: true };
const proven = { version: V, startedAtMs: NOW - STAGE_HEALTHY_MS - 1, healthy: true };
const old = { version: OLD, startedAtMs: NOW - 86_400_000, healthy: true };
const answersOf = (m) => new Map(Object.entries(m));

test('f of a federation: 7 -> 2, 10 -> 3, 4 -> 1', () => {
  assert.deepEqual([faultsOf(7), faultsOf(10), faultsOf(4), faultsOf(1)], [2, 3, 1, 0]);
});

test('a federation of 7, all on the old release: the two lowest keys go, the others wait', () => {
  const answers = answersOf(Object.fromEntries(SEVEN.map((k) => [k, old])));
  const go = SEVEN.map((k) => stageDecision({ version: V, self: k, members: SEVEN, answers, nowMs: NOW }).go);
  assert.deepEqual(go, [true, true, false, false, false, false, false], 'never more than f at once, even if all ask in the same second');
});

test('two on trial: nobody else goes; one of them proven: the next one goes', () => {
  const answers = answersOf({ [SEVEN[0]]: fresh, [SEVEN[1]]: fresh, ...Object.fromEntries(SEVEN.slice(2).map((k) => [k, old])) });
  for (const k of SEVEN.slice(2)) assert.equal(stageDecision({ version: V, self: k, members: SEVEN, answers, nowMs: NOW }).go, false);
  const w = stageDecision({ version: V, self: SEVEN[2], members: SEVEN, answers, nowMs: NOW });
  assert.match(w.why, /wait: 2 guardian\(s\) of 7 run 2026\.2\.0 without a healthy hour/);
  answers.set(SEVEN[0], proven);
  assert.deepEqual(SEVEN.slice(2).map((k) => stageDecision({ version: V, self: k, members: SEVEN, answers, nowMs: NOW }).go), [true, false, false, false, false]);
});

test('on the new release but not healthy (its federation did not advance, or it says so) still counts as on trial', () => {
  const answers = answersOf({ [SEVEN[0]]: { ...proven, healthy: false }, [SEVEN[1]]: fresh, ...Object.fromEntries(SEVEN.slice(2).map((k) => [k, old])) });
  assert.equal(stageDecision({ version: V, self: SEVEN[2], members: SEVEN, answers, nowMs: NOW }).onTrial, 2);
});

test('a fellow that does not answer is not on trial and not ahead; a node that guards nothing is not staged', () => {
  const answers = answersOf({ [SEVEN[0]]: null, [SEVEN[1]]: null, ...Object.fromEntries(SEVEN.slice(2).map((k) => [k, old])) });
  assert.equal(stageDecision({ version: V, self: SEVEN[2], members: SEVEN, answers, nowMs: NOW }).go, true, 'two silent fellows do not block the federation');
  assert.equal(stageDecision({ version: V, self: key(9), members: SEVEN, answers, nowMs: NOW }).go, true);
});
