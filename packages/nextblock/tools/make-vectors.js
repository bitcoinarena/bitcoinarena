// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Golden vectors: input logs and the state hashes they must produce.
//
// The point, from the build order: "a second implementation could be written
// from test-vectors/ alone". So the files carry the inputs, the checkpoints and
// the constants they were produced under - not a reference to this code.

import { writeFileSync, mkdirSync } from 'node:fs';
import { init, step, submitLiquidation, UNITS } from '../src/sim.js';
import { hash } from '../src/state.js';

const DIR = new URL('../test-vectors/', import.meta.url).pathname;
mkdirSync(DIR, { recursive: true });

const CASES = [
  { name: 'straight',  seed: 0x0001, ticks: 3600, input: () => ({ th: 65536, st: 0, br: 0, hb: 0, pr: 0 }) },
  { name: 'slalom',    seed: 0x0002, ticks: 3600,
    input: (t) => ({ th: 65536, st: ((t / 45) | 0) % 2 ? 22000 : -22000, br: 0, hb: 0, pr: 0 }) },
  { name: 'handbrake', seed: 0x0003, ticks: 3600,
    input: (t) => ({ th: 49152, st: 30000, br: 0, hb: (t % 240) < 60 ? 65536 : 0, pr: 0 }) },
  { name: 'reverse',   seed: 0x0004, ticks: 3600,
    input: (t) => ({ th: t < 1200 ? 65536 : -65536, st: 0, br: t >= 1200 && t < 1500 ? 65536 : 0, hb: 0, pr: 0 }) },
  { name: 'idle',      seed: 0x0005, ticks: 3600, input: () => ({ th: 0, st: 0, br: 65536, hb: 0, pr: 0 }) },
  // Practice is an input, so it needs a vector: the same drive shielded, which
  // must diverge from 'straight' at the first shot and set the practice word.
  { name: 'practice',  seed: 0x0001, ticks: 3600, input: () => ({ th: 65536, st: 0, br: 0, hb: 0, pr: 1 }) },
  // A liquidation is an INPUT, not something the core decides, so the replay
  // is only closed if the queue is in the vector too. Three sizes at three
  // ticks: one small, one that the cap has to bite on, and one at zero to pin
  // that a refused submission still leaves a digest a verifier can match.
  { name: 'liquidation', seed: 0x0006, ticks: 3600,
    input: () => ({ th: 65536, st: 0, br: 0, hb: 0, pr: 0 }),
    liq: (t) => (t === 300 ? Math.imul(2, 65536)
              : t === 1200 ? Math.imul(40000, 65536)
              : t === 2400 ? 0 : 0) },
  // The queue alone is not enough: in `liquidation` the truck drives straight
  // out of its apron and never meets the hole, so the fallout rule is never
  // exercised and the transcript could not tell whether it exists. This one
  // steers the truck up the field with a big load already down, so it drives
  // through the crater and the digest carries the irradiation.
  { name: 'fallout', seed: 0x0007, ticks: 3600,
    input: () => ({ th: 65536, st: 0, br: 0, hb: 0, pr: 0 }),
    liq: (t) => ([60, 180, 300, 420].includes(t) ? Math.imul(1000, 65536) : 0) },
];

const index = [];
for (const c of CASES) {
  const st = init(c.seed);
  const checkpoints = [];
  const queued = [];
  for (let t = 0; t < c.ticks; t++) {
    const i = c.input(t);
    const q = c.liq ? c.liq(t) : 0;
    if (q !== 0) { submitLiquidation(st, q); queued.push([t, q]); }
    step(st, i.th, i.st, i.br, i.hb, i.pr);
    if ((t + 1) % 600 === 0) checkpoints.push({ tick: t + 1, hash: hash(st) });
  }
  const vector = {
    name: c.name,
    seed: c.seed,
    ticks: c.ticks,
    units: UNITS,
    note: 'Inputs are Q16.16 in [-1,1]. Order per tick: throttle, steer, brake, handbrake, practice. `liquidations` are [tick, size] pairs handed to submitLiquidation before that tick, size in millions of USD Q16.16. Practice withholds damage but changes nothing else - the army still fires and still counts towards danger, so the draw order is identical.',
    inputs: Array.from({ length: c.ticks }, (_, t) => {
      const i = c.input(t);
      return [i.th, i.st, i.br, i.hb, i.pr];
    }),
    // Sparse on purpose: a liquidation is rare, and 3600 zeroes would say
    // nothing a verifier needs. `[tick, size]`, size in millions of USD
    // Q16.16, submitted BEFORE that tick's `step`.
    liquidations: queued,
    checkpoints,
  };
  writeFileSync(DIR + c.name + '.json', JSON.stringify(vector, null, 1));
  index.push({ name: c.name, ticks: c.ticks, final: checkpoints[checkpoints.length - 1].hash });
  console.log(c.name.padEnd(10) + checkpoints[checkpoints.length - 1].hash);
}
writeFileSync(DIR + 'index.json', JSON.stringify({
  core: 'blwp-core',
  produced: 'tools/make-vectors.js',
  vectors: index,
}, null, 1));
