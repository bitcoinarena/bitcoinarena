// How much army could a wreck rule ever move, and how much condition could a
// hull impact ever cost? An UPPER BOUND, because the share a rule explains is
// an A/B and there is no rule yet to run the B half against.
//
//     node tools/measure-wrecks.js [seed ...] [--seam0] [--airoff]
//
// Read out of C# rather than assumed:
//   `CombatFx.ClaimWreckSlot`  a dead tank leaves (x, z, 4.2) in `Army.Wrecks`
//   `CombatFx` piece           life 25 s, and `Retire` zeroes the radius
//   `Army.AvoidWrecks`         pushes armour out with size 3.2 and infantry
//                              with 0.6, so the reach is 7.4 m and 4.8 m -
//                              NOT the 3 m the parked note used
//   `TruckHealth.OnCollisionEnter` (deleted in d7a3002) charged a hull
//                              `relativeVelocity.magnitude * 3f` and never a
//                              write-off, against `* 6f` and a write-off for a
//                              live tank. The literal `impact * 3f` never
//                              existed in C#; this is what it referred to.
import { init, step } from '../src/sim.js';
import * as L from '../src/state.js';
import { ARMOUR_RADIUS, BODY_RADIUS, BODY_FRONT, BODY_REAR } from '../src/rules/solids.js';

const args = process.argv.slice(2);
const SEAM0 = args.includes('--seam0');
const AIROFF = args.includes('--airoff');
const SEEDS = args.filter((a) => !a.startsWith('--')).map(Number);
if (SEEDS.length === 0) SEEDS.push(20260901);

const Q = 65536;
const { O_UNITS, U_WORDS, U_X, U_Z, U_HP, U_STATE, O_TRUCK, T_X, T_Z, T_HEADING,
        T_VX, T_VZ, T_HP, O_AIR, AIR_BULL, AIR_BEAR, UNITS } = L;

const WRECK_R = 4.2;            // CombatFx.ClaimWreckSlot
const WRECK_LIFE = 25;          // the piece's own life
const ARMOUR_SIZE = 3.2;        // Army.AvoidWrecks
const INF_SIZE = 0.6;
const ARMOUR_MASK = 3;          // every fourth slot is armour, as the core lays it out

const pin = (st) => { if (AIROFF) { st.i32[O_AIR + AIR_BULL] = 0x40000000;
                                    st.i32[O_AIR + AIR_BEAR] = 0x40000000; } };
const isArmour = (i) => (i & ARMOUR_MASK) === 0;
const ux = (s, i) => s[O_UNITS + i * U_WORDS + U_X] / Q;
const uz = (s, i) => s[O_UNITS + i * U_WORDS + U_Z] / Q;
const alive = (s, i) => s[O_UNITS + i * U_WORDS + U_STATE] !== 0;

/** One run. `throttle` 0 parks the truck, ONE drives it down the map. */
function run(seed, throttle, seconds) {
  const st = init(seed);
  if (SEAM0) st.tape.fill(st.tape[0]);        // a flat tape puts the seam at 0, as pinSeam does
  const s = st.i32;
  const wrecks = [];                          // {x, z, born}
  const was = [];
  for (let i = 0; i < UNITS; i++) was[i] = alive(s, i);

  let unitTicks = 0, insideTicks = 0;
  let truckTicks = 0, contactTicks = 0;
  const contacts = [];                        // max closing speed per contact
  let inContact = false, peak = 0;
  const frames = Math.round(seconds * 60);

  for (let f = 0; f < frames; f++) {
    pin(st);
    step(st, throttle, 0, 0, 0, 0);
    const t = f / 60;

    // a tank that died this tick leaves a hull where it stood
    for (let i = 0; i < UNITS; i++) {
      const now = alive(s, i);
      if (was[i] && !now && isArmour(i)) wrecks.push({ x: ux(s, i), z: uz(s, i), born: t });
      was[i] = now;
    }
    const live = wrecks.filter((w) => t - w.born < WRECK_LIFE);

    // (2) how much of the army stands inside one
    for (let i = 0; i < UNITS; i++) {
      if (!alive(s, i)) continue;
      unitTicks++;
      const reach = WRECK_R + (isArmour(i) ? ARMOUR_SIZE : INF_SIZE);
      const x = ux(s, i), z = uz(s, i);
      if (live.some((w) => (w.x - x) ** 2 + (w.z - z) ** 2 < reach * reach)) insideTicks++;
    }

    // (3) how often the truck would be in a hull, and how hard
    if (throttle !== 0) {
      truckTicks++;
      const tx = s[O_TRUCK + T_X] / Q, tz = s[O_TRUCK + T_Z] / Q;
      const h = s[O_TRUCK + T_HEADING] * 2 * Math.PI / Q;
      const fx = Math.sin(h), fz = Math.cos(h);
      const vx = s[O_TRUCK + T_VX] / Q, vz = s[O_TRUCK + T_VZ] / Q;
      const r = (ARMOUR_RADIUS + BODY_RADIUS) / Q;
      let hit = 0;
      for (const off of [BODY_FRONT / Q, BODY_REAR / Q]) {
        const cx = tx + fx * off, cz = tz + fz * off;
        for (const w of live) {
          const dx = cx - w.x, dz = cz - w.z;
          const d = Math.hypot(dx, dz);
          if (d >= r || d === 0) continue;
          const into = -(vx * (dx / d) + vz * (dz / d));
          if (into > hit) hit = into;
        }
      }
      if (hit > 0) { contactTicks++; if (!inContact) { inContact = true; peak = 0; }
                     if (hit > peak) peak = hit; }
      else if (inContact) { inContact = false; contacts.push(peak); }
    }
  }
  if (inContact) contacts.push(peak);
  return { wrecks: wrecks.length, unitTicks, insideTicks, truckTicks, contactTicks,
           contacts, hpLost: 100 - s[O_TRUCK + T_HP] / Q };
}

console.log(`WRECKS conditions:${SEAM0 ? ' seam0' : ''} air=${AIROFF ? 'off(pinned)' : 'on'}` +
            `  wreck r=${WRECK_R} life=${WRECK_LIFE}s  reach armour=${WRECK_R + ARMOUR_SIZE} inf=${WRECK_R + INF_SIZE}`);

const army = SEEDS.map((seed) => run(seed, 0, 90));
for (let i = 0; i < SEEDS.length; i++) {
  const a = army[i];
  console.log(`WRECKS seed=${SEEDS[i]} 90s parked: wrecks=${a.wrecks} ` +
              `unitTicks=${a.unitTicks} inside=${a.insideTicks} ` +
              `share=${(100 * a.insideTicks / a.unitTicks).toFixed(2)}%`);
}
const shares = army.map((a) => 100 * a.insideTicks / a.unitTicks);
const wr = army.map((a) => a.wrecks);
console.log(`WRECKS army bound: wrecks [${Math.min(...wr)}, ${Math.max(...wr)}] ` +
            `mean ${(wr.reduce((x, y) => x + y, 0) / wr.length).toFixed(1)} in 90 s;  ` +
            `living unit-ticks inside a hull [${Math.min(...shares).toFixed(2)}, ` +
            `${Math.max(...shares).toFixed(2)}]% mean ${(shares.reduce((x, y) => x + y, 0) / shares.length).toFixed(2)}%`);

const drive = SEEDS.map((seed) => run(seed, Q, 90));
for (let i = 0; i < SEEDS.length; i++) {
  const d = drive[i];
  // C# charged a hull `speed * 3f` INSIDE Damage, which divided by armour 1.5.
  const cost = d.contacts.reduce((sum, v) => sum + v * 3 / 1.5, 0);
  console.log(`WRECKS seed=${SEEDS[i]} 90s driven: contacts=${d.contacts.length} ` +
              `ticks=${d.contactTicks}/${d.truckTicks} ` +
              `peaks=[${d.contacts.map((v) => v.toFixed(1)).join(',') || '-'}] ` +
              `bound=${cost.toFixed(1)} points  actually lost=${d.hpLost.toFixed(1)}`);
}
const costs = drive.map((d) => d.contacts.reduce((sum, v) => sum + v * 3 / 1.5, 0));
const lost = drive.map((d) => d.hpLost);
const totalCost = costs.reduce((x, y) => x + y, 0), totalLost = lost.reduce((x, y) => x + y, 0);
console.log(`WRECKS hull bound: ${totalCost.toFixed(1)} points across ${SEEDS.length} runs against ` +
            `${totalLost.toFixed(1)} points actually lost = ` +
            `${totalLost > 0 ? (100 * totalCost / totalLost).toFixed(1) : '-'}% of the condition`);
