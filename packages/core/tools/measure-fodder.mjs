// HOW MANY MEN A SIDE LOSES, AND TO WHAT, on the tree that is deployed today.
//
// WAR_TACTICS.md §0's "not cannon fodder" row (§11.3-§11.5) carries a measurement taken on 2026-09-16, BEFORE the
// rules it grades: 26.5 to 41.5 men a side per 60 s, mean 32.7. That number predates the seeded init tape, §1.2's
// hull rectangle, the loading-dock clamp, the world grown east and - most of all - the nuke made lethal on
// 2026-09-19, which kills men in its blast and can only have pushed losses up. Quoting it as today's would be
// quoting a run of a different world.
//
// So this counts the deaths of RIFLEMEN (non-armour indices), per side, per 60 s, over five seeds, and splits them
// by cause. The cause is read from the state, not guessed:
//
//   NUKE   the liquidation strike's serial moved this tick and the man stood inside the crater it is digging
//   BOMB   a gunship bomb that was in the air last tick is gone this tick, and the man stood inside its 16 m
//   FIRE   everything else: the rifles and the guns
//
//   node packages/core/tools/measure-fodder.mjs [--nukes SECONDS]
//
// With no --nukes the army fights its own war, air included; with it, a liquidation is submitted on that cadence,
// which is the world a player actually drives through on the Daily.
import { init, step, submitLiquidation } from '../src/sim.js';
import { cbrt } from '../src/fixed.js';
import * as L from '../src/state.js';

const ONE = 65536, Q = ONE;
const SEEDS = [1, 2, 3, 4, 5];
const SECONDS = 180;                                   // a round, as the contract now runs it
const arg = process.argv.indexOf('--nukes');
const NUKE_EVERY = arg > 0 ? Number(process.argv[arg + 1]) : 0;

// the crater a load digs, as sim.js's own craterOf does it - the blast the nuke clears
const CR_MIN = Math.imul(16, ONE), CR_MAX = Math.imul(40, ONE);
const LOAD_MIN = ONE, LOAD_MAX = Math.imul(1000, ONE);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
function blastOf(load) {
  const lo = cbrt(LOAD_MIN), hi = cbrt(LOAD_MAX);
  const t = clamp(Math.round(((cbrt(clamp(load, LOAD_MIN, LOAD_MAX)) - lo) / (hi - lo)) * ONE), 0, ONE);
  return (CR_MIN + Math.round((t / ONE) * (CR_MAX - CR_MIN))) / Q;
}

const isMan = (i) => (i & L.ARMOUR_MASK) !== 0;
const rows = [];
for (const seed of SEEDS) {
  const st = init(seed), s = st.i32;
  for (let t = 0; t < 900; t++) step(st, Q, 0, 0, 0, 0);   // out of the bay: the war is on before the count starts
  const lost = { '-1': { fire: 0, bomb: 0, nuke: 0 }, 1: { fire: 0, bomb: 0, nuke: 0 } };
  let strikeSerial = s[L.O_STRIKE + L.K_SERIAL];
  let bombsBefore = [];
  for (let t = 0; t < SECONDS * 60; t++) {
    if (NUKE_EVERY > 0 && t % (NUKE_EVERY * 60) === 30) submitLiquidation(st, 4000000);
    const before = [];
    for (let i = 0; i < L.UNITS; i++) {
      if (!isMan(i)) continue;
      const b = L.O_UNITS + i * L.U_WORDS;
      if (s[b + L.U_STATE] === 0 || s[b + L.U_HP] <= 0) continue;
      before.push({ i, side: s[b + L.U_SIDE] < 0 ? -1 : 1, x: s[b + L.U_X] / Q, z: s[b + L.U_Z] / Q });
    }
    const bombs = [];
    for (let k = 0; k < L.MAX_BOMBS; k++) {
      const bb = L.O_BOMBS + k * L.B_WORDS;
      if (s[bb + L.B_STATE] === 0) continue;
      bombs.push({ k, x: s[bb + L.B_X] / Q, z: s[bb + L.B_Z] / Q });
    }

    step(st, Q, 0, 0, 0, 0);

    const nuked = s[L.O_STRIKE + L.K_SERIAL] !== strikeSerial;
    const nx = s[L.O_STRIKE + L.K_X] / Q, nz = s[L.O_STRIKE + L.K_Z] / Q;
    const blast = nuked ? blastOf(s[L.O_STRIKE + L.K_LOAD]) : 0;
    if (nuked) strikeSerial = s[L.O_STRIKE + L.K_SERIAL];
    const gone = [];
    for (const k of bombsBefore) {
      const bb = L.O_BOMBS + k.k * L.B_WORDS;
      if (s[bb + L.B_STATE] === 0) gone.push(k);
    }
    bombsBefore = bombs;

    for (const m of before) {
      const b = L.O_UNITS + m.i * L.U_WORDS;
      // dead, and not a slot refilled this tick by `reinforce`: a replacement walks in from the back edge
      if (s[b + L.U_HP] > 0 && s[b + L.U_STATE] !== 0) {
        if (Math.hypot(s[b + L.U_X] / Q - m.x, s[b + L.U_Z] / Q - m.z) <= 1) continue;
        continue;
      }
      if (nuked && Math.hypot(m.x - nx, m.z - nz) <= blast) { lost[m.side].nuke++; continue; }
      if (gone.some((g) => Math.hypot(m.x - g.x, m.z - g.z) <= 16)) { lost[m.side].bomb++; continue; }
      lost[m.side].fire++;
    }
  }
  const per60 = (n) => (n / SECONDS) * 60;
  for (const side of [-1, 1]) {
    const c = lost[side];
    rows.push({ seed, side, ...c, all: c.fire + c.bomb + c.nuke, per60: per60(c.fire + c.bomb + c.nuke) });
  }
}

console.log(`MEN LOST PER SIDE PER 60 s, five seeds, ${SECONDS} s each${NUKE_EVERY ? `, a nuke every ${NUKE_EVERY} s` : ', no nukes submitted'}`);
console.log('  seed  side      fire    bomb    nuke     all   per 60 s');
for (const r of rows)
  console.log(`  ${String(r.seed).padStart(4)}  ${r.side < 0 ? 'bull' : 'bear'}  ${String(r.fire).padStart(8)}${String(r.bomb).padStart(8)}${String(r.nuke).padStart(8)}${String(r.all).padStart(8)}${r.per60.toFixed(1).padStart(11)}`);
const mean = (f) => rows.reduce((a, r) => a + f(r), 0) / rows.length;
console.log(`\n  mean per side per 60 s: ${mean((r) => r.per60).toFixed(1)}   (the row's bar is <= 20)`);
const total = rows.reduce((a, r) => a + r.all, 0) || 1;
console.log(`  by cause: fire ${(100 * rows.reduce((a, r) => a + r.fire, 0) / total).toFixed(1)}%  ` +
            `bomb ${(100 * rows.reduce((a, r) => a + r.bomb, 0) / total).toFixed(1)}%  ` +
            `nuke ${(100 * rows.reduce((a, r) => a + r.nuke, 0) / total).toFixed(1)}%`);
console.log(`  the 2026-09-16 measurement, for comparison only: 26.5 to 41.5 a side, mean 32.7 - a different world`);
