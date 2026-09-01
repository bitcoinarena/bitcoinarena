#!/usr/bin/env node
// blwp-replay: the standalone verifier, in miniature.
//
// Takes a vector file, replays it, and reports the first tick at which the
// hashes part company. This is the shape the node's replay pool needs - the
// difference there is that it runs in a worker and the transcript comes off
// the wire rather than off disk.
//
//   node tools/replay.js ../../test-vectors/slalom.json

import { readFileSync } from 'node:fs';
import { init, step } from '../src/sim.js';
import { hash } from '../src/state.js';

const path = process.argv[2];
if (!path) { console.error('usage: replay.js <vector.json>'); process.exit(2); }

const v = JSON.parse(readFileSync(path, 'utf8'));
const st = init(v.seed);
const t0 = Date.now();
let bad = -1, at = 0;

for (let t = 0; t < v.ticks; t++) {
  const [th, sr, br, hb, pr] = v.inputs[t];
  step(st, th, sr, br, hb, pr);
  const cp = v.checkpoints[at];
  if (cp && cp.tick === t + 1) {
    if (hash(st) !== cp.hash && bad < 0) bad = cp.tick;
    at++;
  }
}
const ms = Date.now() - t0;
const rt = (v.ticks / 60) / (ms / 1000);

console.log(v.name + ': ' + v.ticks + ' ticks in ' + ms + ' ms  (' + rt.toFixed(0) + 'x realtime)');
if (bad < 0) { console.log('  all ' + at + ' checkpoints match'); process.exit(0); }
console.error('  DIVERGED at tick ' + bad);
process.exit(1);
