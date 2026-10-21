// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
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
const DIR = new URL('../test-vectors/', import.meta.url).pathname;
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

/**
 * EVERY NAME THE MODULES EXPORT IS DECLARED IN THE BUNDLE.
 *
 * Found the hard way: the bundler stripped `export { ... }` lists with a lazy
 * match that CROSSED LINES, so an `export { UNITS, ARMOUR_MASK };` early in
 * `sim.js` and an `export { TICK_DT } from './tick.js';` later in the same
 * file matched as one span and deleted the fifty-five lines between them -
 * including `export const HALF_X`. The bundle kept nine USES of it and no
 * declaration, so the page threw "HALF_X is not defined" on the first step.
 * Nothing noticed, because the committed bundle predated the re-export and the
 * suites load the committed file.
 *
 * A test that runs the bundle catches it only for the paths it drives. This
 * catches it for every name, which is the shape of the fault: a declaration
 * silently gone while its callers stay.
 */
test('every exported name in src is declared in the bundle', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const src = new URL('../src/', import.meta.url).pathname;
  const dist = readFileSync(new URL('../dist/blwp-core.js', import.meta.url).pathname, 'utf8');

  // THE MODULES THE BUNDLE ACTUALLY CARRIES, read off its own markers. Files
  // nothing imports are not in it and their exports are not missing - only a
  // name from a module that IS in there and has lost its declaration is the
  // fault this catches.
  const included = [...dist.matchAll(/^\/\/ ---- (\S+\.js)$/gm)].map((m) => m[1]);
  assert.ok(included.length >= 10, `the bundle names only ${included.length} modules`);
  const files = included.map((rel) => src + rel);

  const missing = [];
  let checked = 0;
  for (const file of files) {
    for (const m of readFileSync(file, 'utf8')
      .matchAll(/^export\s+(?:async\s+)?(?:const|function|class|let|var)\s+([A-Za-z_$][\w$]*)/gm)) {
      checked++;
      const declared = new RegExp(`^(?:async\\s+)?(?:const|function|class|let|var)\\s+${m[1]}\\b`, 'm');
      if (!declared.test(dist)) missing.push(`${m[1]} (${file.split('/').pop()})`);
    }
  }
  assert.ok(checked > 50, `only ${checked} exported names were checked`);
  assert.deepEqual(missing, [], `the bundle uses names it never declares: ${missing.join(', ')}`);
});

/**
 * AND EVERY NAME A MODULE IMPORTS UNDER ANOTHER NAME IS DECLARED TOO.
 *
 * Found in two real Chromes on the Daily, 2026-09-10: ROLL OUT threw
 * "heatForLoad is not defined". `sim.js` imports `heat as heatForLoad`, the
 * bundler stripped the import, and the flat bundle had `heat` and no
 * `heatForLoad`. The export check above could not see it - nothing was
 * exported under that name - and no test ran the load through the bundle.
 */
test('every aliased import in the bundled modules is declared in the bundle', async () => {
  const { readFileSync } = await import('node:fs');
  const src = new URL('../src/', import.meta.url).pathname;
  const dist = readFileSync(new URL('../dist/blwp-core.js', import.meta.url).pathname, 'utf8');
  const included = [...dist.matchAll(/^\/\/ ---- (\S+\.js)$/gm)].map((m) => m[1]);
  const aliases = [];
  for (const rel of included)
    for (const m of readFileSync(src + rel, 'utf8').matchAll(/^import\s*\{([^{}]*)\}\s*from/gm))
      for (const n of m[1].split(',')) {
        const a = n.trim().match(/^[A-Za-z_$][\w$]*\s+as\s+([A-Za-z_$][\w$]*)$/);
        if (a) aliases.push(`${a[1]} (${rel})`);
      }
  assert.ok(aliases.length >= 1, 'no aliased import was found, so this checks nothing');
  const missing = aliases.filter((a) => !new RegExp(`^(?:var|const|let|function)\\s+${a.split(' ')[0]}\\b`, 'm').test(dist));
  assert.deepEqual(missing, [], `the bundle uses aliases it never declares: ${missing.join(', ')}`);
});

/**
 * THE LOAD, THROUGH THE BUNDLE THE PAGE RUNS - the exact path that threw.
 */
test('a load submitted to the bundle heats the run exactly as the modules do', async () => {
  const { submitLoad, heatOf } = await import('../src/sim.js');
  const a = init(7);
  const b = bundled.init(7);
  for (const [fee, btc] of [[22011, 3], [40000, 0], [0, 250]]) {
    assert.doesNotThrow(() => bundled.submitLoad(b, fee, btc), 'the bundle threw on a load');
    submitLoad(a, fee, btc);
    assert.equal(bundled.heatOf(b), heatOf(a), `heat parted on a load of ${fee} sat, ${btc}/100 BTC`);
    for (let t = 0; t < 60; t++) { step(a, 45875, 0, 0, 0, 0); bundled.step(b, 45875, 0, 0, 0, 0); }
    assert.equal(bundled.hash(b), hash(a), 'the bundle and the modules parted after a load');
  }
});
