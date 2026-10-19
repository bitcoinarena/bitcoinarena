// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
//: flat-out top speed and 0 -> 12 m/s, the standard truck and a large one ({ topSpeed, driveAccel } given), on this core.
// node tools/measure-large-truck.mjs [topSpeed driveAccel ...]  - the same run as large-truck.test.js: seed 0x5eed1234, full throttle
import { init, step } from '../frozen/f0cc7b7b/sim.js';
import { O_TRUCK, T_WHEEL } from '../frozen/f0cc7b7b/state.js';
import { TICK_DT } from '../frozen/f0cc7b7b/tick.js';
import { ONE } from '../frozen/f0cc7b7b/fixed.js';
import { vehicleStep } from '../frozen/f0cc7b7b/rules/vehicle.js';
const SEED = 0x5eed1234, TICKS = 1500, TO = 12 * 65536;
export function measure(truck) {
  const st = init(SEED); if (truck) st.truck = truck;
  let best = 0, at12 = null;
  for (let i = 0; i < TICKS; i++) {
    step(st, ONE, 0, 0, 0, 0);
    const v = Math.abs(st.i32[O_TRUCK + T_WHEEL]);
    if (v > best) best = v;
    if (at12 === null && v >= TO) at12 = i + 1;
  }
  const dt = TICK_DT / 65536;
  return { top: best / 65536, ticksTo12: at12, secTo12: at12 === null ? null : at12 * dt };
}
/** THE SAME TRUCK ON FLAT GROUND, nothing in the way: the vehicle step alone (rules/vehicle.js), full throttle, straight. */
export function measureFlat(truck, hp) {
  const v = { x: 0, z: 0, heading: 0, vx: 0, vz: 0, angVel: 0, steerAngle: 0, speed: 0, hp, pull: 1,
    topSpeed: truck ? truck.topSpeed : 0, driveAccel: truck ? truck.driveAccel : 0 };
  let best = 0, at12 = null;
  for (let i = 0; i < 6000; i++) {
    vehicleStep(v, ONE, 0, 0, 0, TICK_DT, 0);
    const s = Math.abs(v.speed);
    if (s > best) best = s;
    if (at12 === null && s >= TO) at12 = i + 1;
  }
  return { top: best / 65536, ticksTo12: at12, secTo12: at12 === null ? null : at12 * TICK_DT / 65536 };
}
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log('stock', JSON.stringify(measure(null)));
  const a = process.argv.slice(2).map(Number);
  for (let i = 0; i + 1 < a.length; i += 2) console.log(a[i], a[i + 1], JSON.stringify(measure({ bedLength: 255590, topSpeed: a[i], driveAccel: a[i + 1] })));
}
