// DO TANKS ACTUALLY STAND IN THE MINER'S DRAWN PARTS? (2026-09-20)
// The item says "a tank can stand in a drawn cable". The truck half is fixed and measured; this asks whether the
// tank half is real, and how often, before anything is changed. Read from the core's own unit table.
import { init, step, submitLiquidation } from '../src/sim.js';
import * as L from '../src/state.js';
const Q = 65536, isMan = (i) => (i & L.ARMOUR_MASK) !== 0;
// the two cables and the corridor lining, in world metres, as measure-miner-solids printed them
const PARTS = [
  ['power_cable_0', 108.4, 120.7, 22.4, 34.2], ['power_cable_1', 108.4, 120.8, 23.1, 33.6],
  ['tunnel_rib_l_*', 146.0, 168.5, 32.8, 34.0], ['tunnel_rib_r_*', 146.0, 168.5, -34.0, -32.8],
  ['tunnel_wall_l', 145.0, 169.0, 34.0, 36.4], ['tunnel_wall_r', 145.0, 169.0, -36.4, -34.0],
  ['tunnel_grid_v_*', 144.8, 146.0, -32.0, 32.0],
];
const HULL = 3.2;                                    // the hull's own size, as army.js uses for craters
let tankTicks = 0, inPart = 0, east = 0;
const per = new Map();
for (const seed of [1, 2, 3]) {
  const st = init(seed), s = st.i32;
  for (let t = 0; t < 900; t++) step(st, Q, 0, 0, 0, 0);
  for (let t = 0; t < 3600; t++) {
    if (t % 1800 === 300) submitLiquidation(st, 4000000);
    step(st, Q, 0, 0, 0, 0);
    for (let i = 0; i < L.UNITS; i++) {
      if (isMan(i)) continue;
      const b = L.O_UNITS + i * L.U_WORDS;
      if (s[b + L.U_STATE] === 0 || s[b + L.U_HP] <= 0) continue;
      tankTicks++;
      const x = s[b] / Q, z = s[b + 1] / Q;
      if (x > 100) east++;
      for (const [name, x0, x1, z0, z1] of PARTS) {
        if (x + HULL < x0 || x - HULL > x1 || z + HULL < z0 || z - HULL > z1) continue;
        inPart++; per.set(name, (per.get(name) || 0) + 1);
        break;
      }
    }
  }
}
const pc = (a, b) => `${(100 * a / Math.max(b, 1)).toFixed(3)}%`;
console.log(`TANKS AGAINST THE MINER'S DRAWN PARTS - 3 seeds x 60 s, hull size ${HULL} m\n`);
console.log(`  living tank-ticks              ${tankTicks}`);
console.log(`  ...standing east of x 100      ${east}  (${pc(east, tankTicks)})`);
console.log(`  ...inside a drawn miner part   ${inPart}  (${pc(inPart, tankTicks)})`);
for (const [k, v] of [...per.entries()].sort((a, b) => b[1] - a[1])) console.log(`      ${k.padEnd(18)} ${v}`);
if (inPart === 0) console.log(`\n  No tank ever stood in one of these parts in this run.`);
