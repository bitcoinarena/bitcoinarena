// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Poison tests: make the banned functions explode, then run the corpus.
//
// The AST guard catches a call it can see. This catches one it cannot - a
// Math.sin reached through a computed property, an alias, or a dependency that
// slipped in. If any of them is reachable the tests blow up instead of quietly
// diverging months later on somebody's Safari.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const POISON = ['sin', 'cos', 'tan', 'atan', 'atan2', 'pow', 'exp', 'log',
                'sqrt', 'cbrt', 'hypot', 'random'];

test('the core runs with every nondeterministic Math function poisoned', async () => {
  const saved = {};
  for (const name of POISON) {
    saved[name] = Math[name];
    Math[name] = () => { throw new Error('poisoned Math.' + name + ' was called'); };
  }
  const savedNow = Date.now;
  Date.now = () => { throw new Error('poisoned Date.now was called'); };

  try {
    const { init, step } = await import('../src/sim.js');
    const { hash } = await import('../src/state.js');
    const st = init(0x5eed1234);
    for (let t = 0; t < 2000; t++) step(st, 40000, ((t * 977) % 65536) - 32768, 0, 0);
    assert.equal(hash(st).length, 64);
  } finally {
    for (const name of POISON) Math[name] = saved[name];
    Date.now = savedNow;
  }
});

test('a float stored into the state cannot survive', async () => {
  const { create } = await import('../src/state.js');
  const st = create();
  st.i32[5] = 1.5;
  assert.equal(st.i32[5], 1, 'Int32Array must truncate - there is nowhere for a fraction to live');
});

test('the same seed gives the same world, a different seed does not', async () => {
  const { init, step } = await import('../src/sim.js');
  const { hash } = await import('../src/state.js');
  const run = (seed) => {
    const st = init(seed);
    for (let t = 0; t < 500; t++) step(st, 50000, 12345, 0, 0);
    return hash(st);
  };
  assert.equal(run(7), run(7));
  assert.notEqual(run(7), run(8));
});
