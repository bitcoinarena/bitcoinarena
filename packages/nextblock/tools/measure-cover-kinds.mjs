// THE CLOSE-OUT NUMBER FOR §11.3: claims REACHED, split by kind.
//
// the owner 2026-09-19: "Occupancy 89.8% on lips alone is not evidence the named kinds are used." §0's row counts a
// man on any place, so one kind of place can carry it while the two the section is named for are never stood in.
// This tool refuses to add the kinds together. For each of the three (wreck, crater, candle lip) it counts the
// man-ticks on which a claim of that kind is HELD and, of those, the ones on which its holder is within the row's
// own 0.5 m of it.
//
// It also prints the two things a held-but-unreached claim would otherwise hide:
//
//   A CLAIM'S LIFE, in seconds - a claim taken and dropped before the man can walk to it is not cover.
//   THE RUSH GATE (§11.2, §11.3: he walks "when his fire team's clock says rush") - man-ticks on which the team's
//     clock says HALT and the man moved anyway. The gate is `walk = 0` in army.js, shared with the walk to his
//     line post; this counts whether anything steps around it, rather than asserting that nothing does.
//
//   node packages/nextblock/tools/measure-cover-kinds.mjs
import { init, step, submitLiquidation } from '../src/sim.js';
import { standingStill } from '../src/rules/army.js';
import * as T from '../src/rules/tactics.js';
const HALF_REST_TICKS = 210;                       // sim.js's own, §11.2 half of a mean 7 s rest
import * as L from '../src/state.js';

const Q = 65536;
const SEEDS = [1, 2];
const SECONDS = 60;
const isMan = (i) => (i & L.ARMOUR_MASK) !== 0;
const WRECK_MAX = L.UNITS * 2, CRATER_MAX = WRECK_MAX + L.MAX_CRATERS * 4;
const KINDS = ['wreck', 'crater', 'lip'];
const kindOf = (id) => (id < WRECK_MAX ? 'wreck' : id < CRATER_MAX ? 'crater' : 'lip');

const held = { wreck: 0, crater: 0, lip: 0 }, on = { wreck: 0, crater: 0, lip: 0 };
const lives = { wreck: [], crater: [], lip: [] };
let haltedTicks = 0, haltedMoved = 0, haltedPushed = 0, haltedWalked = 0, manTicks = 0, claimTicks = 0;

for (const seed of SEEDS) {
  const st = init(seed), s = st.i32;
  for (let t = 0; t < 900; t++) step(st, Q, 0, 0, 0, 0);
  const openAt = new Map(), openKind = new Map();
  for (let t = 0; t < SECONDS * 60; t++) {
    if (t % 1800 === 300) submitLiquidation(st, 4000000);
    // the fire team clocks of the tick ABOUT TO RUN, as sim.js builds them (it bumps O_TICK before the infantry step) (§11.2), and where every man stands
    const halt = [[], []];
    for (let sd = 0; sd < 2; sd++)
      for (let f = 0; f < T.FIRE_TEAMS_PER_SIDE; f++) {
        const key = T.mix(s[L.O_TACTICS + T.TAC_SEED], 500 + Math.imul(sd, 16) + f) & 0x7fffffff;
        const raw = standingStill(key, (s[L.O_TICK] + 1 - ((f & 1) === 1 ? HALF_REST_TICKS : 0)) | 0);
        halt[sd][f] = raw && !(f > 0 && halt[sd][f - 1]);
      }
    const was = new Map();
    for (let i = 0; i < L.UNITS; i++) {
      if (!isMan(i)) continue;
      const b = L.O_UNITS + i * L.U_WORDS;
      if (s[b + L.U_STATE] === 0 || s[b + L.U_HP] <= 0) continue;
      was.set(i, [s[b + L.U_X], s[b + L.U_Z], halt[T.rifleTeamOf(i).side < 0 ? 0 : 1][T.rifleTeamOf(i).team]]);
    }

    step(st, Q, 0, 0, 0, 0);

    for (let i = 0; i < L.UNITS; i++) {
      if (!isMan(i)) continue;
      const b = L.O_UNITS + i * L.U_WORDS;
      const alive = s[b + L.U_STATE] !== 0 && s[b + L.U_HP] > 0;
      const id = alive ? T.coverClaim(s, L.O_TACTICS, i) : T.COVER_NONE;
      // a claim's life: the tick it was taken until the tick it is no longer the same id
      const prev = openAt.get(i);
      if (prev !== undefined && openKind.get(i) !== id) {
        lives[kindOf(openKind.get(i))].push((t - prev) / 60);
        openAt.delete(i); openKind.delete(i);
      }
      if (!alive) continue;
      manTicks++;
      const b4 = was.get(i);
      if (b4 && b4[2]) {                                  // his team's clock said HALT this tick
        haltedTicks++;
        if (Math.abs(s[b + L.U_X] - b4[0]) + Math.abs(s[b + L.U_Z] - b4[1]) > Math.round(Q / 100)) {
          haltedMoved++;
          // ...and a PUSH is not a walk. §8.3's hull clearance stands a man exactly 3 m off a living tank's centre
          // after every step, halted or not, and §3's replacement walks in from the back edge as a column. Counted
          // apart, so the gate is measured on the thing it gates.
          let pushed = false;
          for (let j = 0; j < L.UNITS; j += 4) {
            const tb = L.O_UNITS + j * L.U_WORDS;
            if (s[tb + L.U_STATE] === 0) continue;
            if (Math.hypot((s[b + L.U_X] - s[tb + L.U_X]) / Q, (s[b + L.U_Z] - s[tb + L.U_Z]) / Q) <= 3.05) { pushed = true; break; }
          }
          if (pushed) haltedPushed++; else haltedWalked++;
        }
      }
      if (id === T.COVER_NONE) continue;
      claimTicks++;
      if (openAt.get(i) === undefined) { openAt.set(i, t); openKind.set(i, id); }
      const side = s[b + L.U_SIDE] < 0 ? -1 : 1;
      const p = T.coverPlace(s, id, side, st.candles && !st.noCandleField ? st.candles : null, st.candleShift | 0);
      if (!p) continue;
      const k = kindOf(id);
      held[k]++;
      if (Math.hypot((s[b + L.U_X] - p.x) / Q, (s[b + L.U_Z] - p.z) / Q) <= 0.5) on[k]++;
    }
  }
}

const pc = (a, b) => `${((100 * a) / Math.max(b, 1)).toFixed(1)}%`;
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
console.log(`CLAIMS REACHED BY KIND, ${SEEDS.length} seeds x ${SECONDS} s, a nuke every 30 s`);
console.log('  kind      man-ticks held      reached          a claim lives');
for (const k of KINDS)
  console.log(`  ${k.padEnd(8)}${String(held[k]).padStart(14)}${String(on[k]).padStart(11)} (${pc(on[k], held[k])})${mean(lives[k]).toFixed(1).padStart(13)} s  (${lives[k].length})`);
console.log(`  ${'ALL'.padEnd(8)}${String(KINDS.reduce((a, k) => a + held[k], 0)).padStart(14)}` +
            `${String(KINDS.reduce((a, k) => a + on[k], 0)).padStart(11)} ` +
            `(${pc(KINDS.reduce((a, k) => a + on[k], 0), KINDS.reduce((a, k) => a + held[k], 0))})`);
console.log(`\n  man-ticks holding a claim   ${claimTicks} of ${manTicks}  (${pc(claimTicks, manTicks)})`);
console.log(`  THE RUSH GATE (§11.2): man-ticks with the fire team's clock on HALT   ${haltedTicks}`);
console.log(`    ...of those, the man moved more than 0.01 m                        ${haltedMoved}  (${pc(haltedMoved, haltedTicks)})`);
console.log(`    ...of those, stood 3 m off a tank: §8.3's clearance push, not a walk ${haltedPushed}`);
console.log(`    ...of those, an actual WALK while halted                            ${haltedWalked}  <- the gate`);
console.log(`    A man walks to his place only while his team rushes, by the same gate as the walk to his line post`);
console.log(`    (army.js: walk = 0 when the team is halted, and both dx and dz are taken from walk).`);
