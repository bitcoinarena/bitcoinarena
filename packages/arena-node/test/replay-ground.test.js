// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE PLAYER AND THE COMMITTEE DRIVE ONE GROUND, AND NOBODY IS TOLD WHAT IT IS.
//
// Two two-Chrome looks disagreed and both were honest. 19:27 measured each
// tab's picture of the other against that truck's own core at (0.000, 0.000) m;
// 19:31 watched a chip crawl -100,-3 to -97,-3 while that truck was out in the
// tank field. The difference was the ground: `init` left a core flat until a
// host uploaded relief, the PAGE uploaded `MempoolTerrain.HeightGrid`, and the
// daemon's replay uploaded nothing. Measured on one seed and one drive, the
// ground the only difference:
//
//     after 20 ticks, still on the level apron    0.000 m apart
//     after 600 ticks                            33.500 m apart
//
// The apron is level by construction, which is why a look taken there could
// not tell the two apart and a look taken in the field could.
//
// It was not fixable by sending the grid: `HeightAt` was `Mathf.Log10` of a
// LIVE mempool profile plus `Mathf.PerlinNoise` - a host's live data through
// Unity's float maths - and a player publishing their own heights would be
// choosing the world they are scored in. So the core generates the relief from
// the round's seed, and this file is what that is worth.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { init, step } from '../../nextblock/src/sim.js';
import { O_TRUCK, T_X, T_Z } from '../../nextblock/src/state.js';

const M = (w) => (w / 65536).toFixed(3);
const WORDS = [45875, 22000, 0, 0, 0];

test('no daemon gives a replay its ground, and no page can set one', () => {
  const src = readdirSync(new URL('../src/', import.meta.url))
    .filter((f) => f.endsWith('.js'))
    .map((f) => ({ f, text: readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8') }));
  const uploaders = src.filter((s) => /\bsetGround\s*\(|\bsetSolids\s*\(/.test(s.text));
  assert.deepEqual(uploaders.map((s) => s.f), [],
    'something in src/ hands a replay a world - it should be getting it from the seed');

  // AND THE DOOR THE PAGE USED IS GONE. Not the word - the comments that say
  // why it went are worth keeping - but the callable thing.
  const jslib = readFileSync(
    new URL('../../../unity-proto/Assets/Plugins/WebGL/blwp.jslib', import.meta.url), 'utf8');
  const core = readFileSync(
    new URL('../../../unity-proto/Assets/Scripts/Blwp/BlwpCore.cs', import.meta.url), 'utf8');
  const truck = readFileSync(
    new URL('../../../unity-proto/Assets/Scripts/Blwp/CoreDrivenTruck.cs', import.meta.url), 'utf8');
  assert.equal(/BlwpSetGround\s*:/.test(jslib), false, 'the bridge still exports a ground door');
  assert.equal(/bool\s+SetGround\s*\(/.test(core), false, 'BlwpCore still offers SetGround');
  assert.equal(/void\s+UploadGround\s*\(/.test(truck), false, 'the truck still uploads a ground');
  console.log('  files in the daemon that hand a replay a ground: 0');
  console.log('  doors a page could set the ground through: 0');
});

test('the ground travels in nothing, because both sides already hold the seed', () => {
  for (const f of ['contracts.js', 'transcript.js', 'batch.js', 'checkpoint.js']) {
    const text = readFileSync(new URL(`../../arena-protocol/src/${f}`, import.meta.url), 'utf8');
    assert.equal(/heightGrid|heights|terrain|relief/i.test(text), false,
      `${f} carries the ground now - it does not need to, because the seed makes it`);
  }
  console.log('  the ground is in no contract, no batch, no mark and no transcript');
});

/**
 * THE NUMBER THAT HAD TO MOVE, and the same pair that produced 33.500 m.
 */
test('one drive on the page and the same drive replayed end in the same place', () => {
  const seed = 0x1d3fd8b6;
  const page = init(seed);          // what a browser steps
  const committee = init(seed);     // what a node replaying the transcript steps

  for (let t = 0; t < 20; t++) { step(page, ...WORDS); step(committee, ...WORDS); }
  const early = Math.hypot(
    (page.i32[O_TRUCK + T_X] - committee.i32[O_TRUCK + T_X]) / 65536,
    (page.i32[O_TRUCK + T_Z] - committee.i32[O_TRUCK + T_Z]) / 65536);

  for (let t = 20; t < 600; t++) { step(page, ...WORDS); step(committee, ...WORDS); }
  const apart = Math.hypot(
    (page.i32[O_TRUCK + T_X] - committee.i32[O_TRUCK + T_X]) / 65536,
    (page.i32[O_TRUCK + T_Z] - committee.i32[O_TRUCK + T_Z]) / 65536);

  console.log(`  after 20 ticks the two are ${early.toFixed(3)} m apart`);
  console.log(`  after 600 ticks the page is at (${M(page.i32[O_TRUCK + T_X])}, ${M(page.i32[O_TRUCK + T_Z])}) m`);
  console.log(`                   the replay is at (${M(committee.i32[O_TRUCK + T_X])}, ${M(committee.i32[O_TRUCK + T_Z])}) m`);
  console.log(`  they are ${apart.toFixed(3)} m apart - it was 33.500 m`);

  assert.equal(early, 0);
  assert.equal(apart, 0, 'the page and the committee still drive different worlds');

  // AND THE WORLD THEY AGREE ON IS NOT A TABLE, or they agreed about nothing.
  let rolled = 0;
  for (const h of page.ground.h) if (h !== 0) rolled++;
  assert.ok(rolled > 0, 'the world they agree on is flat, so this measured nothing');
  let peak = 0;
  for (const h of page.ground.h) if (h > peak) peak = h;
  console.log(`  and it is not flat: ${rolled} of ${page.ground.h.length} cells carry relief, up to ${M(peak)} m`);
});

/**
 * TWO ROUNDS ARE TWO WORLDS. A generator that answered the same hills for every
 * seed would pass the test above and mean nothing at all.
 */
test('two seeds are two grounds, and both aprons stay level', () => {
  const a = init(0x1d3fd8b6);
  const b = init(0xc4eab5b8);
  let differ = 0;
  for (let i = 0; i < a.ground.h.length; i++) if (a.ground.h[i] !== b.ground.h[i]) differ++;
  console.log(`  two seeds differ in ${differ} of ${a.ground.h.length} cells`);
  assert.ok(differ > a.ground.h.length / 4, 'two rounds are drawn on the same hills');

  // THE APRONS ARE LEVEL IN BOTH, which is not decoration: the bays are 24
  // doors across 156 m of it, and a door on a slope is a truck that rolls out
  // of it sideways. Both trucks stand at x -100.4, so the ground under every
  // bay has to be the same height in every round.
  const cols = a.ground.cols, rows = a.ground.rows;
  const col = Math.round((-100.4 / 130 + 1) / 2 * (cols - 1));
  for (let r = 0; r < rows; r++) {
    assert.equal(a.ground.h[r * cols + col], 0, `round A's apron is not level at row ${r}`);
    assert.equal(b.ground.h[r * cols + col], 0, `round B's apron is not level at row ${r}`);
  }
  console.log('  and every bay in both rounds stands on level ground');
});
