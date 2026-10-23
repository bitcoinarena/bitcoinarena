// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SETTLE SWEEP'S WAIT (kanban #576): a refused round is asked again after 10, 20, 40, then every 60 s; an answer with a
// state clears the wait; rounds no longer waiting drop out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSettleBackoff } from '../src/settle-backoff.js';

test('a refused round waits 10, 20, 40, then 60 s at most; a round never refused is always due', () => {
  let t = 0;
  const b = createSettleBackoff({ now: () => t });
  assert.equal(b.due('a'), true);
  const gaps = [];
  for (let i = 0; i < 5; i++) {
    b.refused('a');
    const from = t;
    while (!b.due('a')) t += 1000;
    gaps.push(t - from);
  }
  assert.deepEqual(gaps, [10000, 20000, 40000, 60000, 60000]);
  assert.equal(b.due('b'), true, 'another round is not held by a\'s wait');
});

test('an answer with a state clears the wait; keep drops the rounds no longer waiting', () => {
  let t = 0;
  const b = createSettleBackoff({ now: () => t });
  b.refused('a'); b.refused('b');
  assert.equal(b.due('a'), false);
  b.clear('a');
  assert.equal(b.due('a'), true);
  b.refused('a'); b.refused('c');
  b.keep(new Set(['a']));
  assert.equal(b.size(), 1);
  assert.equal(b.due('b'), true);
  assert.equal(b.due('c'), true);
  b.refused('a');
  assert.equal(b.due('a'), false, 'the wait doubles from the tries kept');
});

test("a refusal that cannot change waits up to its own cap: 10, 20, 40, 80 s ... 30 min, and another round keeps 60 s", () => {
  let t = 0;
  const b = createSettleBackoff({ now: () => t });
  const gaps = [];
  for (let i = 0; i < 10; i++) {
    b.refused("x", { maxMs: 1800000 });
    const from = t;
    while (!b.due("x")) t += 1000;
    gaps.push(t - from);
  }
  assert.deepEqual(gaps, [10000, 20000, 40000, 80000, 160000, 320000, 640000, 1280000, 1800000, 1800000]);
  b.refused("y"); b.refused("y"); b.refused("y"); b.refused("y"); b.refused("y");
  const from = t;
  while (!b.due("y")) t += 1000;
  assert.equal(t - from, 60000, "without a cap of its own a round waits 60 s at most");
});
