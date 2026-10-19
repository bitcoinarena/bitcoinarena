// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Replaying the golden vectors.
//
// This is the test that will still matter in a year: it is what tells a second
// implementation that it has got the rules right, and it is what tells this
// one that a refactor changed behaviour it did not mean to change.
//
// A failure here is never "update the vectors". It is either a deliberate rule
// change - in which case the vectors are regenerated ON PURPOSE and the
// protocol version moves - or a bug.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { init, step, submitLiquidation } from '../src/sim.js';
import { hash } from '../src/state.js';

const DIR = new URL('../../../test-vectors/', import.meta.url).pathname;
const index = JSON.parse(readFileSync(DIR + 'index.json', 'utf8'));

for (const entry of index.vectors) {
  test('vector: ' + entry.name, () => {
    const v = JSON.parse(readFileSync(DIR + entry.name + '.json', 'utf8'));
    const st = init(v.seed);
    let checked = 0;
    for (let t = 0; t < v.ticks; t++) {
      for (const [at, size] of v.liquidations || [])
        if (at === t) submitLiquidation(st, size);
      const [th, sr, br, hb, pr] = v.inputs[t];
      step(st, th, sr, br, hb, pr);
      const cp = v.checkpoints[checked];
      if (cp && cp.tick === t + 1) {
        assert.equal(hash(st), cp.hash,
          `${entry.name} diverged at tick ${cp.tick}`);
        checked++;
      }
    }
    assert.equal(checked, v.checkpoints.length, 'not every checkpoint was reached');
  });
}
