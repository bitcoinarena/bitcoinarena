// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { init, START_X, START_Z, bayZ, spawnBay, BAY_COUNT, SOLO_BAY } from '../src/sim.js';
import { SOLO_SEED } from '../src/rng.js';
import { O_TRUCK, T_X, T_Z } from '../src/state.js';

test('the harness seed still parks in the solo bay', () => {
  assert.equal(spawnBay(SOLO_SEED), SOLO_BAY);
  const st = init(SOLO_SEED);
  assert.equal(st.i32[O_TRUCK + T_X], START_X);
  assert.equal(st.i32[O_TRUCK + T_Z], START_Z);
});

test('two different player seeds park in two different bays', () => {
  const a = spawnBay(1);
  const b = spawnBay(2);
  assert.notEqual(a, b);
  assert.notEqual(bayZ(a), bayZ(b));
  const sa = init(1);
  const sb = init(2);
  assert.equal(sa.i32[O_TRUCK + T_X], START_X);
  assert.equal(sb.i32[O_TRUCK + T_X], START_X);
  assert.notEqual(sa.i32[O_TRUCK + T_Z], sb.i32[O_TRUCK + T_Z]);
});

test('the same seed always parks at the same door', () => {
  assert.equal(spawnBay(99), spawnBay(99));
  assert.equal(init(99).i32[O_TRUCK + T_Z], init(99).i32[O_TRUCK + T_Z]);
});

test('every bay is on the apron, none past the 24 doors', () => {
  const seen = new Set();
  for (let s = 0; s < 4096; s++) {
    const bay = spawnBay(s);
    assert.ok(bay >= 0 && bay < BAY_COUNT);
    seen.add(bay);
  }
  assert.equal(seen.size, BAY_COUNT);
});
