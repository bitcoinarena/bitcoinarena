// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE LARGER TRUCK (the first in-game item): a run handed its unlock drives a 3.9 m bed and 15 % more drive acceleration,
// topping out on flat ground where the accepted larger truck did (25.30 m/s); a run handed none, or an unlock this core does not know,
// is exactly the run it was - every state hash the same.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { init, step, submitLoad, cargoOf } from '../frozen/f0cc7b7b/sim.js';
import { hash, O_TRUCK, T_WHEEL } from '../frozen/f0cc7b7b/state.js';
import { CORE } from '../frozen/f0cc7b7b/adapter.js';
import { LARGE_TRUCK, LARGE_TRUCK_UNLOCK, truckFor, BED_LENGTH, TOP_SPEED, DRIVE_ACCEL } from '../frozen/f0cc7b7b/items.js';
import { measure, measureFlat } from '../tools/measure-large-truck.mjs';
import { init as initTruck, step as stepTruck } from '../src/sim.js';
import { hash as hashTruck } from '../src/state.js';
import { LARGE_TRUCK_ITEM_UNLOCK, NEXTBLOCK_ITEMS } from '../plugin/truck-cores.js';
import { fill } from '../frozen/f0cc7b7b/rules/cargo.js';
import { ONE } from '../frozen/f0cc7b7b/fixed.js';

const SEED = 0x5eed1234;
const drive = (st, ticks, words = [ONE, 0, 0, 0, 0]) => { const out = []; for (let i = 0; i < ticks; i++) { step(st, ...words); out.push(hash(st)); } return out; };

test('the unlock names exactly the truck\'s numbers; an unknown unlock is the standard truck', () => {
  assert.equal(LARGE_TRUCK_UNLOCK, '10dec674eb2f698400bb775c508e727d9c15734a6e7056889d12bb0ebab54d69');
  assert.equal(LARGE_TRUCK_ITEM_UNLOCK, LARGE_TRUCK_UNLOCK, 'the registration sells the unlock the core knows');
  assert.deepEqual(NEXTBLOCK_ITEMS.map((i) => [i.id, i.priceSat]), [['large-truck', 500n]]);
  assert.equal(LARGE_TRUCK.bedLength, Math.floor(BED_LENGTH * 13 / 10));
  assert.equal(LARGE_TRUCK.driveAccel, Math.floor(DRIVE_ACCEL * 115 / 100), '15 % more drive acceleration, in the core\'s own units');
  assert.equal(DRIVE_ACCEL, 285082);
  assert.equal(LARGE_TRUCK.topSpeed, 2235175);
  assert.deepEqual(truckFor([LARGE_TRUCK_UNLOCK.toUpperCase()]), { bedLength: 255590, topSpeed: 2235175, driveAccel: 327844 });
  assert.equal(truckFor(['26b48061ea64c4d83eeb1c2da2c9df23beed349acb2ead1260c9cb127462e8e8']), null, 'the v1 unlock (no acceleration) is no truck');
  assert.equal(truckFor(['00'.repeat(32)]), null);
  assert.equal(truckFor([]), null);
});

test('a run without the item hashes exactly as before: no items, an empty list, an unknown unlock', () => {
  const base = drive(init(SEED), 400);
  assert.deepEqual(drive(init(SEED, { items: [] }), 400), base);
  assert.deepEqual(drive(init(SEED, { items: ['ab'.repeat(32)] }), 400), base);
  assert.deepEqual(drive(CORE.start(SEED, null, {}), 400), base, 'the adapter without items');
  // AND IT IS THE TRUCK (68e2b3d6, src) TICK FOR TICK: without the item this core plays exactly the live core's runs
  const live = initTruck(SEED); const liveHashes = []; for (let i = 0; i < 400; i++) { stepTruck(live, ONE, 0, 0, 0, 0); liveHashes.push(hashTruck(live)); }
  assert.deepEqual(base, liveHashes, 'without the item, f0cc7b7b and the truck give the same state hashes');
});

test('the same load fills less of the larger bed: 30 % more room', () => {
  const room = 200000;                                   // what a load's transactions take, Q16.16
  const small = init(SEED); submitLoad(small, 1000, 100, room);
  const large = init(SEED, { items: [LARGE_TRUCK_UNLOCK] }); submitLoad(large, 1000, 100, room);
  assert.equal(cargoOf(small), fill(room));
  assert.equal(cargoOf(large), fill(room, LARGE_TRUCK.bedLength));
  assert.ok(cargoOf(large) < cargoOf(small));
  // what fills the standard bed fills 1/1.3 of the larger one
  const full = Math.imul(BED_LENGTH, 2);
  assert.equal(fill(full), ONE);
  assert.ok(Math.abs(fill(full, LARGE_TRUCK.bedLength) - Math.round(ONE / 1.3)) <= 2);
});

test('quicker off the line, the same top speed: 0 -> 12 m/s about 15 % sooner, flat out where the accepted larger truck topped out', () => {
  const HP = 100 * ONE;
  const stock = measureFlat(null, HP), big = measureFlat(LARGE_TRUCK, HP);
  const accepted = measureFlat({ topSpeed: 2339635, driveAccel: DRIVE_ACCEL }, HP);   // the larger truck before the pick: top speed only
  const course = { stock: measure(null), big: measure(truckFor([LARGE_TRUCK_UNLOCK])) };
  console.log('  FACTS:', JSON.stringify({ flat: { stock, big, accepted }, course }));
  assert.equal(big.top, accepted.top, 'flat out it tops out exactly where the accepted larger truck did');
  assert.ok(big.top > stock.top && big.top < stock.top * 1.04, 'a little above the standard truck, not more');
  const quicker = 1 - big.secTo12 / stock.secTo12;
  assert.ok(quicker > 0.12 && quicker < 0.18, `0 -> 12 m/s ${(quicker * 100).toFixed(1)} % sooner`);
  assert.ok(course.big.secTo12 < course.stock.secTo12, 'and sooner on the seed\'s course too');
});

test('flat out on the course, never past its own top speed', () => {
  const top = (st) => { let best = 0; for (let i = 0; i < 1500; i++) { step(st, ONE, 0, 0, 0, 0); best = Math.max(best, Math.abs(st.i32[O_TRUCK + T_WHEEL])); } return best; };
  const std = top(init(SEED));
  const big = top(CORE.start(SEED, null, { items: [LARGE_TRUCK_UNLOCK] }));
  assert.ok(std <= TOP_SPEED);
  assert.ok(big <= LARGE_TRUCK.topSpeed, 'capped at its own reference speed');
});
