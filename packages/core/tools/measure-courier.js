// The truck under fire, laid beside csharp-infantry.json's `courier` pass.
//
// That pass parks a truck at x=0, z=0 and leaves it there for ninety seconds,
// taking whatever the army gives it, and publishes eighteen samples of
//
//     t, rifleHits, rifleDmg, tankHits, tankDmg, totalDmg, inRifle, inTank
//
// It splits rifle from tank BY THE SIZE OF THE HIT, and says so: CourierHit
// carries only an amount, and with Heat at zero the two bands are disjoint -
// a rifle takes 1.5-3.5, a tank 5-11. That is a property of the recorder, not
// of the rule, and it is quoted here as such.
//
//     node tools/measure-courier.js [seed ...] [--seam0]
//
// WHERE THE TRUCK STANDS IS THE PAIR. The recording parks it at (0, 0), in the
// middle of the seam. Every other tool in this directory leaves it at START,
// (-100.4, 10.2) on the apron - and that is 12.4 m from the army's western
// edge, which is why the `idle` vector takes damage at all. Measuring here
// with the truck at START would be the sixth not-a-pair in this item. It is
// placed with `teleport`, the core's own respawn API: it writes position words
// and clears the momentum, and it draws NOTHING from the stream.
//
// WHAT CAN AND CANNOT BE PAIRED TODAY. `totalDmg`, `inRifle` and `inTank` are
// exact pairs. The rifle/tank SPLIT is not recoverable from the core, because
// every core hit is one flat point: the two weapons have no distinct damage to
// tell them apart by. That is not a gap in this tool - it is one of the four
// faults item (j) exists to fix, and after (j) the split becomes readable the
// same way the recording reads it.
//
// Prints; asserts nothing.

import { readFileSync } from 'node:fs';
import { init, step, teleport, UNITS } from '../src/sim.js';
import * as L from '../src/state.js';

// The recording's courier pass is `air: "none"`, so this run must be too, or
// it is not a pair - the same fault the depth pair was made of. The air is
// held down from OUTSIDE the rules, exactly as measure-infantry.js does it:
// the sortie clocks are pinned high so `launchSorties` returns without
// drawing, and any live gunship or bomb is cleared. No rule is called and
// nothing but the air's own state words is written.
const CLOCK_HIGH = 1 << 30;
const HAS_AIR = typeof L.O_HELIS === 'number';
function holdAir(st) {
  if (!HAS_AIR) return st;
  const s = st.i32;
  s[L.O_AIR + L.AIR_BULL] = CLOCK_HIGH;
  s[L.O_AIR + L.AIR_BEAR] = CLOCK_HIGH;
  for (let i = 0; i < L.MAX_HELIS; i++) s[L.heliBase(i) + L.H_STATE] = 0;
  for (let i = 0; i < L.MAX_BOMBS; i++) s[L.bombBase(i) + L.B_STATE] = 0;
  return st;
}

const args = process.argv.slice(2);
const SEAM0 = args.includes('--seam0');
const SEEDS = args.filter((a) => !a.startsWith('--')).map(Number);

const ref = JSON.parse(readFileSync(new URL('../test/vectors/csharp-infantry.json', import.meta.url), 'utf8'));
const PASS = ref.passes.courier;
const REC = PASS.rows;
const [CX, CZ] = PASS.courier;
const COURIER_RANGE = ref.setup.courierRange;      // 34, read off the file
const RIFLE_R = ref.setup.rifleRange;              // 26
if (SEEDS.length === 0) SEEDS.push(ref.setup.seed);

const Q = 65536, q = (v) => v / Q, fx = (m) => Math.round(m * Q);
const isArmour = (i) => (i & 3) === 0;
const T = L.O_TRUCK;

console.log(`COURIER  truck parked at (${CX}, ${CZ}) for ${ref.setup.durationSeconds} s, ` +
            `the recording's own courier position`);
console.log(`COURIER  recording: seed ${ref.setup.seed}, ${ref.setup.seam}, air ${ref.setup.air}, ` +
            `heat ${ref.setup.heat}, flow ${ref.setup.flow}`);
console.log('COURIER  the core is run AIR OFF to match, by pinning the sortie clocks from');
console.log('COURIER  outside the rules - the recording\'s pass is air "none".');
console.log(`COURIER  courierRange ${COURIER_RANGE} m, rifleRange ${RIFLE_R} m - both read off the file`);
console.log('COURIER  rifle/tank split is NOT recoverable from the core: every core hit is one');
console.log('COURIER  flat point, so there is no size to tell the two weapons apart by. That is');
console.log('COURIER  one of the faults (j) exists to fix, not a gap in this tool.');

function measure(seed) {
  const st = init(seed);
  if (SEAM0) st.tape.fill(st.tape[0]);
  holdAir(st);
  teleport(st, fx(CX), fx(CZ), 0);
  const hp0 = st.i32[T + L.T_HP];
  const rows = [];
  const SAMPLE = 5 * 60;
  for (let f = 0; f < ref.setup.durationSeconds * 60; f++) {
    step(st, 0, 0, 0, 0, 0);
    holdAir(st);
    if ((f + 1) % SAMPLE) continue;
    const tx = q(st.i32[T + L.T_X]), tz = q(st.i32[T + L.T_Z]);
    let inRifle = 0, inTank = 0;
    for (let i = 0; i < UNITS; i++) {
      const b = L.unitBase(i);
      if (st.i32[b + L.U_STATE] === 0 || st.i32[b + L.U_HP] <= 0) continue;
      const d = Math.hypot(q(st.i32[b + L.U_X]) - tx, q(st.i32[b + L.U_Z]) - tz);
      if (isArmour(i)) { if (d < COURIER_RANGE) inTank++; }
      else if (d < RIFLE_R) inRifle++;
    }
    rows.push({ t: (f + 1) / 60, dmg: q(hp0 - st.i32[T + L.T_HP]), inRifle, inTank,
                x: tx, z: tz });
  }
  return rows;
}

for (const seed of SEEDS) {
  const rows = measure(seed);
  const pair = seed === ref.setup.seed;
  console.log('');
  console.log(`COURIER seed=${seed}${SEAM0 ? ' seam0' : ''}` +
              (pair ? '   REC column is the recording\'s courier pass' : '   (the recording holds only its own seed - no REC cells)'));
  console.log('COURIER    t   core dmg  inRifle  inTank  |  REC totalDmg  rifleHits  tankHits  inRifle  inTank');
  rows.forEach((r, k) => {
    const c = pair ? REC[k] : null;
    console.log(`COURIER  ${String(r.t).padStart(3)}   ${r.dmg.toFixed(2).padStart(8)}  ` +
                `${String(r.inRifle).padStart(7)}  ${String(r.inTank).padStart(6)}  | ` +
                (c ? `${c.totalDmg.toFixed(2).padStart(11)}  ${String(c.rifleHits).padStart(9)}  ` +
                     `${String(c.tankHits).padStart(8)}  ${String(c.inRifle).padStart(7)}  ${String(c.inTank).padStart(6)}`
                   : '          -'));
  });
  const last = rows[rows.length - 1];
  console.log(`COURIER  the truck ended at (${last.x.toFixed(2)}, ${last.z.toFixed(2)}) - it must not have moved`);
  if (pair) {
    const c = REC[REC.length - 1];
    console.log('');
    console.log('COURIER  AT NINETY SECONDS          core        recording');
    console.log(`COURIER    total damage        ${last.dmg.toFixed(2).padStart(10)}  ${c.totalDmg.toFixed(2).padStart(12)}`);
    console.log(`COURIER    of it, tank                  none  ${c.tankDmg.toFixed(2).padStart(12)}   (${c.tankHits} hits)`);
    console.log(`COURIER    of it, rifle          not split  ${c.rifleDmg.toFixed(2).padStart(12)}   (${c.rifleHits} hits)`);
    console.log(`COURIER    riflemen within ${RIFLE_R} m ${String(last.inRifle).padStart(9)}  ${String(c.inRifle).padStart(12)}`);
    console.log(`COURIER    tanks within ${COURIER_RANGE} m    ${String(last.inTank).padStart(9)}  ${String(c.inTank).padStart(12)}`);
  }
}
