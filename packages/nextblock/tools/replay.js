#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// blwp-replay: the standalone verifier, in miniature.
//
// Takes a vector file, replays it, and reports the first tick at which the
// hashes part company. This is the shape the node's replay pool needs - the
// difference there is that it runs in a worker and the transcript comes off
// the wire rather than off disk.
//
//   node tools/replay.js test-vectors/slalom.json

import { readFileSync } from 'node:fs';
import { init, step } from '../src/sim.js';
import { hash } from '../src/state.js';

const path = process.argv[2];
if (!path) { console.error('usage: replay.js <vector.json | transcript.bin> [seed]'); process.exit(2); }

// A TRANSCRIPT OFF THE WIRE, which is the thing this file's own comment said
// the node's replay pool would need. A vector is a file we wrote; a transcript
// is what a node hands over, and the whole point of M2.1 step 2 is that the
// two replay to the same place. Told apart by the first byte - a transcript
// carries its type - so neither needs a flag.
const raw = readFileSync(path);
if (raw[0] === 0x09) {
  const { decodeTranscript, checkTranscript, flatten } =
    await import('arena-sdk/transcript');
  const t = decodeTranscript(new Uint8Array(raw));
  const chain = checkTranscript(t);
  if (!chain.ok) { console.error(`the chain is broken at ${chain.in} ${chain.at}: ${chain.why}`); process.exit(1); }

  const { firstTick, ticks, liquidations, loads } = flatten(t);
  if (firstTick !== 0) { console.error(`this transcript starts at tick ${firstTick}, not 0`); process.exit(1); }

  const seed = Number(process.argv[3] || 1);
  const { submitLiquidation, submitLoad } = await import('../src/sim.js');
  const st = init(seed);
  const due = new Map(liquidations.map(([at, size]) => [at, size]));
  // The load lands before its own tick, like a strike. A replay that skipped
  // it would be hunted at zero while the player was hunted for a full bed.
  const bed = new Map(loads.map(([at, ...rest]) => [at, rest]));   // [fee, btc] or [fee, btc, room]
  for (let i = 0; i < ticks.length; i++) {
    if (bed.has(i)) submitLoad(st, ...bed.get(i));
    if (due.has(i)) submitLiquidation(st, due.get(i));
    step(st, ticks[i][0], ticks[i][1], ticks[i][2], ticks[i][3], ticks[i][4]);
  }
  console.log(`${ticks.length} ticks, ${liquidations.length} liquidation(s), ${loads.length} load(s)`);
  console.log(hash(st));
  process.exit(0);
}

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
