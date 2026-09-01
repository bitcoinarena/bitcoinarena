// Golden vectors: input logs and the state hashes they must produce.
//
// The point, from the build order: "a second implementation could be written
// from test-vectors/ alone". So the files carry the inputs, the checkpoints and
// the constants they were produced under - not a reference to this code.

import { writeFileSync, mkdirSync } from 'node:fs';
import { init, step, UNITS } from '../src/sim.js';
import { hash } from '../src/state.js';

const DIR = new URL('../../../test-vectors/', import.meta.url).pathname;
mkdirSync(DIR, { recursive: true });

const CASES = [
  { name: 'straight',  seed: 0x0001, ticks: 3600, input: () => ({ th: 65536, st: 0, br: 0, hb: 0 }) },
  { name: 'slalom',    seed: 0x0002, ticks: 3600,
    input: (t) => ({ th: 65536, st: ((t / 45) | 0) % 2 ? 22000 : -22000, br: 0, hb: 0 }) },
  { name: 'handbrake', seed: 0x0003, ticks: 3600,
    input: (t) => ({ th: 49152, st: 30000, br: 0, hb: (t % 240) < 60 ? 65536 : 0 }) },
  { name: 'reverse',   seed: 0x0004, ticks: 3600,
    input: (t) => ({ th: t < 1200 ? 65536 : -65536, st: 0, br: t >= 1200 && t < 1500 ? 65536 : 0, hb: 0 }) },
  { name: 'idle',      seed: 0x0005, ticks: 3600, input: () => ({ th: 0, st: 0, br: 65536, hb: 0 }) },
];

const index = [];
for (const c of CASES) {
  const st = init(c.seed);
  const checkpoints = [];
  for (let t = 0; t < c.ticks; t++) {
    const i = c.input(t);
    step(st, i.th, i.st, i.br, i.hb);
    if ((t + 1) % 600 === 0) checkpoints.push({ tick: t + 1, hash: hash(st) });
  }
  const vector = {
    name: c.name,
    seed: c.seed,
    ticks: c.ticks,
    units: UNITS,
    note: 'Inputs are Q16.16 in [-1,1]. Order per tick: throttle, steer, brake, handbrake.',
    inputs: Array.from({ length: c.ticks }, (_, t) => {
      const i = c.input(t);
      return [i.th, i.st, i.br, i.hb];
    }),
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
