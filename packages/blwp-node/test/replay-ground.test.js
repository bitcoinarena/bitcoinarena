// THE WORLD A COMMITTEE REPLAYS IN IS FLAT, AND THE ONE THE PLAYER DROVE IS NOT.
//
// The two-Chrome look at 19:31 reported the other truck's chip crawling from
// -100,-3 to -97,-3 while that truck was out in the tank field. The look at
// 19:27 measured the same chip agreeing with the driver's own core to
// (0.000, 0.000) m. Both are true, and this is why: everything measured at
// 19:27 happened on the apron, which is FLAT and has no solids on it, and the
// two worlds agree exactly there.
//
// `init` leaves a core "flat until the host uploads the relief", and the page
// uploads one - `CoreDrivenTruck.UploadGround` calls `BlwpCore.SetGround` with
// `MempoolTerrain.HeightGrid`, and `UploadSolids` the same for the boxes. The
// daemon's replay does neither: `RunInProgress` calls `init(seedWord)` and
// steps. So the committee replays every run on a table while the player drove
// hills, and the ghost every other player is shown is that flat run.
//
// IT IS NOT ONLY THE GHOST. The same replay decides the outcome and the score
// this round pays on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { init, step, setGround, HALF_X } from '../../core/src/sim.js';
import { O_TRUCK, T_X, T_Z } from '../../core/src/state.js';

const M = (w) => (w / 65536).toFixed(3);
const WORDS = [45875, 22000, 0, 0, 0];

/**
 * A relief of the shape the page uploads: a grid of Q16.16 heights, LEVEL over
 * the apron and rising beyond it.
 *
 * The levelling is not decoration. `MempoolTerrain.HeightAt` flattens both ends
 * of the map into an apron on purpose - "a metre of remaining relief anywhere
 * under it is a metre of daylight under one end" - so a truck standing at its
 * loading bay is on ground the two worlds agree about exactly. That is why the
 * 19:27 look measured zero and the 19:31 look did not.
 */
function reliefBeyondTheApron(cols, rows, perMetre, apronEndsAtX = -95) {
  const h = new Int32Array(cols * rows);
  const halfX = HALF_X / 65536;                       // the map is 260 m across
  const xOf = (c) => -halfX + (c / (cols - 1)) * halfX * 2;
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const x = xOf(c);
      h[r * cols + c] = x <= apronEndsAtX ? 0 : Math.round((x - apronEndsAtX) * perMetre * 65536);
    }
  return h;
}

test('the daemon\'s replay never uploads a ground, and the page always does', () => {
  const src = readdirSync(new URL('../src/', import.meta.url))
    .filter((f) => f.endsWith('.js'))
    .map((f) => ({ f, text: readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8') }));
  const uploaders = src.filter((s) => /\bsetGround\s*\(|\bsetSolids\s*\(/.test(s.text));
  assert.deepEqual(uploaders.map((s) => s.f), [],
    'something in src/ gives the replay a ground now - update the letter');

  // AND THE PLAYER'S SIDE DOES, which is the half that makes it a difference.
  const cs = readFileSync(
    new URL('../../../unity-proto/Assets/Scripts/Blwp/CoreDrivenTruck.cs', import.meta.url), 'utf8');
  assert.match(cs, /BlwpCore\.SetGround\(/, 'the page stopped uploading a ground');
  assert.match(cs, /BlwpCore\.SetSolids\(/, 'the page stopped uploading solids');
  console.log('  files in the daemon that give a replay its ground: 0');
  console.log('  the page uploads both a height grid and the solids');
});

test('the ground is in no round contract and no transcript, so a replay cannot ask for it', () => {
  for (const f of ['contracts.js', 'transcript.js', 'batch.js', 'checkpoint.js']) {
    const text = readFileSync(new URL(`../../protocol/src/${f}`, import.meta.url), 'utf8');
    assert.equal(/heightGrid|heights|terrain|relief/i.test(text), false,
      `${f} carries something about the ground now - the letter can be closed differently`);
  }
  console.log('  the ground appears in no contract, no batch, no mark and no transcript');
});

/**
 * WHAT THE FLAT REPLAY COSTS, which is the number this letter turns on.
 *
 * One seed, one drive, six hundred ticks. The only difference is the ground the
 * core was given.
 */
test('one drive replayed flat ends metres from the same drive on a relief', () => {
  const seed = 0x1d3fd8b6;
  const flat = init(seed);
  const hilly = init(seed);
  assert.equal(setGround(hilly, 160, 96, reliefBeyondTheApron(160, 96, 0.25)), true, 'the relief was refused');

  // ON THE APRON THEY AGREE, and that is why 19:27 measured zero. The first
  // ticks are the roll-out, on ground the map levels flat by construction.
  for (let t = 0; t < 20; t++) { step(flat, ...WORDS); step(hilly, ...WORDS); }
  const early = Math.hypot(
    (flat.i32[O_TRUCK + T_X] - hilly.i32[O_TRUCK + T_X]) / 65536,
    (flat.i32[O_TRUCK + T_Z] - hilly.i32[O_TRUCK + T_Z]) / 65536);

  for (let t = 20; t < 600; t++) { step(flat, ...WORDS); step(hilly, ...WORDS); }
  const dx = (flat.i32[O_TRUCK + T_X] - hilly.i32[O_TRUCK + T_X]) / 65536;
  const dz = (flat.i32[O_TRUCK + T_Z] - hilly.i32[O_TRUCK + T_Z]) / 65536;
  const apart = Math.hypot(dx, dz);

  console.log(`  after 20 ticks the two worlds are ${early.toFixed(3)} m apart`);
  console.log(`  after 600 ticks flat is at (${M(flat.i32[O_TRUCK + T_X])}, ${M(flat.i32[O_TRUCK + T_Z])}) m`);
  console.log(`                   relief is at (${M(hilly.i32[O_TRUCK + T_X])}, ${M(hilly.i32[O_TRUCK + T_Z])}) m`);
  console.log(`  they are ${apart.toFixed(3)} m apart`);

  assert.equal(early, 0, `the two worlds already differ by ${early} m on the level apron`);
  assert.ok(apart > 5, `a flat replay of a drive on a relief is only ${apart} m out, so this is not the cause`);
});
