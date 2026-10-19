// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE WALLS A REPLAY RESOLVES AGAINST ARE THE WALLS THE PLAYER DROVE INTO.
//
// The ground was the first host-supplied world and this was the second.
// `WorldSolids.Gather` collected every BoxCollider Unity had built AT RUNTIME
// and `CoreDrivenTruck.UploadSolids` sent them, re-sending whenever the count
// changed - so the world the core resolved against moved mid-run as models
// streamed in. No replay set any, so a committee resolved every drive against
// nothing.
//
// The map's boxes are the core's now, made from the map's own geometry and the
// relief the core generated. `SolidsInventoryTests` takes the set a real
// `Bootstrap` builds out of a running player; the numbers it printed are
// pinned below, so the core's boxes and the ones Unity draws cannot drift
// apart without a red test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { init, step, setSolids, HALF_X, HALF_Z } from '../../nextblock/src/sim.js';
import { mapSolids, MAP_BOXES } from '../../nextblock/src/rules/map.js';
import { BOX_WORDS } from '../../nextblock/src/rules/solids.js';
import { O_TRUCK, T_X, T_Z } from '../../nextblock/src/state.js';

const M = (w) => (w / 65536).toFixed(3);
const WORDS = [45875, 0, 0, 0, 0];       // full throttle, straight out of the bay
const ONE = 65536;

test('no daemon hands a replay a collision world, and no page can send one', () => {
  const src = readdirSync(new URL('../src/', import.meta.url))
    .filter((f) => f.endsWith('.js'))
    .map((f) => ({ f, text: readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8') }));
  assert.deepEqual(src.filter((s) => /\bsetSolids\s*\(/.test(s.text)).map((s) => s.f), [],
    'something in src/ hands a replay a collision world - it should come from the map');

  const jslib = readFileSync(
    new URL('../../../unity-proto/Assets/Plugins/WebGL/blwp.jslib', import.meta.url), 'utf8');
  const core = readFileSync(
    new URL('../../../unity-proto/Assets/Scripts/Blwp/BlwpCore.cs', import.meta.url), 'utf8');
  const truck = readFileSync(
    new URL('../../../unity-proto/Assets/Scripts/Blwp/CoreDrivenTruck.cs', import.meta.url), 'utf8');
  assert.equal(/BlwpSetSolids\s*:/.test(jslib), false, 'the bridge still exports a solids door');
  assert.equal(/bool\s+SetSolids\s*\(/.test(core), false, 'BlwpCore still offers SetSolids');
  assert.equal(/void\s+UploadSolids\s*\(/.test(truck), false, 'the truck still uploads a collision world');
  console.log('  files in the daemon that hand a replay a collision world: 0');
  console.log('  doors a page could send one through: 0');
});

/**
 * THE BOXES THE CORE MAKES ARE THE BOXES UNITY BUILDS.
 *
 * Taken off a running player by `SolidsInventoryTests`: 37 boxes, four map
 * edges, the post office shell of twenty-five pillars on the bays' own 6.8 m
 * pitch with its two ends and its lintel, and the miner's facade, lintel and
 * two tunnel sides. Centres and extents are the map's and do not move with the
 * round; only the heights do, because every shell rests on the relief.
 */
test('the core builds the map Unity draws, box for box', () => {
  const st = init(0x028b8279);
  const s = mapSolids(st.ground, HALF_X, HALF_Z);
  // THE TOTAL IS THE CORE'S CONSTANT, AND 37 WAS NEVER THE TOTAL. `map.js` records
  // the breakdown beside it: MAP_BOXES = 106 = "37 map + 41 miner corridor + 4 coin
  // stacks + 24 post office mouths". The 37 that `SolidsInventoryTests` gathered off
  // a running player is the MAP's own boxes - the four edges, the post office shell,
  // the miner's facade - and those are still checked one by one below, by centre and
  // extent to the millimetre. Asserting the whole count equals that subtotal compared
  // a total against a part of itself, and went red the day the corridor, the stacks
  // and the mouths were added on purpose.
  assert.equal(s.n, MAP_BOXES);

  const at = (i) => {
    const b = i * BOX_WORDS;
    return { cx: s.box[b] / ONE, cz: s.box[b + 1] / ONE, hx: s.box[b + 2] / ONE, hz: s.box[b + 3] / ONE };
  };
  const has = (cx, cz, hx, hz, what) => {
    const found = Array.from({ length: s.n }, (_, i) => at(i)).some((b) =>
      Math.abs(b.cx - cx) < 0.001 && Math.abs(b.cz - cz) < 0.001
      && Math.abs(b.hx - hx) < 0.001 && Math.abs(b.hz - hz) < 0.001);
    assert.ok(found, `${what} is not among the core's boxes`);
  };

  // THE FOUR EDGES ARE NOT BOXES ANY MORE (ruling 4, 2026-09-22): "the map edge is a clamp, not
  // a wall. The core owes no wall solids, and the client stops drawing walls the core does not build."
  // This used to assert the four the player gathered - Wall_West/East at +-130 by 1.5 x 88, North/South
  // at +-85 by 133 x 1.5. Asserting their ABSENCE rather than deleting the lines keeps the ruling
  // pinned: a core that starts building edge walls again fails here, and so does a client that draws
  // boxes this does not carry.
  const none = (cx, cz, what) => {
    const found = Array.from({ length: s.n }, (_, i) => at(i)).some((b) =>
      Math.abs(b.cx - cx) < 0.001 && Math.abs(b.cz - cz) < 0.001);
    assert.ok(!found, `${what} is still among the core's boxes: the edge is a clamp, not a wall`);
  };
  none(-130, 0, 'Wall_West');
  none(130, 0, 'Wall_East');
  none(0, -85, 'Wall_North');
  none(0, 85, 'Wall_South');

  // The post office: 25 pillars from z -81.6 on a 6.8 m pitch, two ends, a lintel.
  for (let i = 0; i <= 24; i++) has(-118.4, -81.6 + 6.8 * i, 4, 0.9, `Pillar${i}`);
  has(-118.4, -82.875, 4, 1.275, 'EndLeft');
  has(-118.4, 82.875, 4, 1.275, 'EndRight');
  has(-118.4, 0, 4, 84.15, 'Lintel');

  // The miner, whose shell faces the player so its own axes run the other way.
  has(112.4, -62.2, 4, 22.2, 'FacadeRight');
  has(112.4, 62.2, 4, 22.2, 'FacadeLeft');
  has(112.4, 0, 4, 40, 'FacadeLintel');
  has(125.4, -42, 14, 2, 'TunnelRight');
  has(125.4, 42, 14, 2, 'TunnelLeft');
  console.log(`  the core builds all ${s.n} boxes a running player gathered, centre and extents to a millimetre`);

  // AND THE HEIGHTS FOLLOW THE ROUND, because a shell rests on the relief
  // the round generated and buried twenty metres so a dip cannot open a gap.
  const other = mapSolids(init(0xc4eab5b8).ground, HALF_X, HALF_Z);
  let sameXZ = 0, sameY = 0;
  for (let i = 0; i < s.n; i++) {
    const b = i * BOX_WORDS;
    if (s.box[b] === other.box[b] && s.box[b + 1] === other.box[b + 1]) sameXZ++;
    if (s.box[b + 4] === other.box[b + 4] && s.box[b + 5] === other.box[b + 5]) sameY++;
  }
  assert.equal(sameXZ, s.n, 'the map moved between two rounds');
  console.log(`  two rounds: all ${sameXZ} boxes stand in the same place, ${sameY} of ${s.n} at the same height`);
});

/**
 * THE NUMBER THAT HAD TO MOVE, and it is the one the letter was opened on.
 *
 * A drive that meets a wall, stepped twice: once as the page steps it and once
 * as a committee replaying the same inputs does. Before this letter the page
 * had the walls Unity gathered and the replay had none.
 */
test('a drive into a wall replays into the same wall', () => {
  const seed = 0x028b8279;
  // A drive that reaches the post office shell behind the bays: full throttle
  // with the wheel over, so the truck comes round into it.
  const turn = [45875, -30000, 0, 0, 0];

  const page = init(seed);
  const committee = init(seed);
  for (let t = 0; t < 600; t++) { step(page, ...turn); step(committee, ...turn); }
  const apart = Math.hypot(
    (page.i32[O_TRUCK + T_X] - committee.i32[O_TRUCK + T_X]) / ONE,
    (page.i32[O_TRUCK + T_Z] - committee.i32[O_TRUCK + T_Z]) / ONE);
  console.log(`  page   (${M(page.i32[O_TRUCK + T_X])}, ${M(page.i32[O_TRUCK + T_Z])}) m`);
  console.log(`  replay (${M(committee.i32[O_TRUCK + T_X])}, ${M(committee.i32[O_TRUCK + T_Z])}) m`);
  console.log(`  they are ${apart.toFixed(3)} m apart, and both hold ${page.solids.n} boxes`);
  assert.equal(apart, 0);
  assert.equal(page.solids.n, MAP_BOXES);
  assert.equal(committee.solids.n, MAP_BOXES);

  // AND THE OLD PATH, MEASURED, so the fix is worth a number rather than a
  // claim: one box on one side is the whole of what a host could do.
  //
  // THE PROBE BOX HAS TO BE ON THE PATH, and the first one written here was
  // not: a slab at (-85, -20) spanning z -60..20, while this drive never gets
  // west of x -63.9 below z 20. It read 0.000 m and would have gone on reading
  // 0.000 m however broken the door was. It is a slab across the road now, at
  // x -60 on the straight run out of the bay, and the truck stops at it.
  const hosted = init(seed);
  const extra = new Int32Array((MAP_BOXES + 1) * BOX_WORDS);
  extra.set(page.solids.box, 0);
  const b = MAP_BOXES * BOX_WORDS;
  extra[b] = -60 * ONE; extra[b + 1] = 714 * (ONE / 10);  // centre, z 71.4 - the bay's own lane
  extra[b + 2] = 5 * ONE; extra[b + 3] = 30 * ONE;        // half extents
  extra[b + 4] = -2 * ONE; extra[b + 5] = 5 * ONE;        // y, joined in the ground
  assert.equal(setSolids(hosted, MAP_BOXES + 1, extra), true);
  const fresh = init(seed);
  for (let t = 0; t < 600; t++) { step(hosted, ...WORDS); step(fresh, ...WORDS); }
  console.log(`  with the host's box   (${M(hosted.i32[O_TRUCK + T_X])}, ${M(hosted.i32[O_TRUCK + T_Z])}) m`);
  console.log(`  without it            (${M(fresh.i32[O_TRUCK + T_X])}, ${M(fresh.i32[O_TRUCK + T_Z])}) m`);
  const hostedApart = Math.hypot(
    (hosted.i32[O_TRUCK + T_X] - fresh.i32[O_TRUCK + T_X]) / ONE,
    (hosted.i32[O_TRUCK + T_Z] - fresh.i32[O_TRUCK + T_Z]) / ONE);
  console.log(`  one box a host could once have added: ${hostedApart.toFixed(3)} m of divergence`);
  assert.ok(hostedApart > 1, 'a host box no longer moves a drive, so this measures nothing');
});
