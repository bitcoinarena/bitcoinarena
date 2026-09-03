// The bundle must be the same core, or it is a second implementation nobody
// asked for.
//
// This compares state hashes between the module build and the concatenated
// one across every golden vector. If they ever differ, the bundler has
// transformed something it should not have - and since the bundle is what the
// browser runs, that difference would show up as players desyncing from the
// nodes that verify them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { init, step, submitLiquidation } from '../src/sim.js';
import { hash } from '../src/state.js';

const require = createRequire(import.meta.url);
const bundled = require('../dist/blwp-core.js');
const DIR = new URL('../../../test-vectors/', import.meta.url).pathname;
const index = JSON.parse(readFileSync(DIR + 'index.json', 'utf8'));

test('the bundle exposes what the bridge needs', () => {
  for (const k of ['init', 'step', 'hash', 'runScore', 'create', 'WORDS'])
    assert.ok(bundled[k] !== undefined, 'bundle is missing ' + k);
});

for (const entry of index.vectors) {
  test('bundle matches modules: ' + entry.name, () => {
    const v = JSON.parse(readFileSync(DIR + entry.name + '.json', 'utf8'));

    const a = init(v.seed);
    const b = bundled.init(v.seed);
    for (let t = 0; t < v.ticks; t++) {
      for (const [at, size] of v.liquidations || [])
        if (at === t) { submitLiquidation(a, size); bundled.submitLiquidation(b, size); }
      const [th, sr, br, hb, pr] = v.inputs[t];
      step(a, th, sr, br, hb, pr);
      bundled.step(b, th, sr, br, hb, pr);
      if ((t + 1) % 900 === 0)
        assert.equal(bundled.hash(b), hash(a),
          entry.name + ': bundle and modules parted at tick ' + (t + 1));
    }
    assert.equal(bundled.hash(b), entry.final);
  });
}
