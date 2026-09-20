// §0's FAULT LIST, THE TRUCK LINE, MEASURED (2026-09-20): "a man's claim or posture differs between the truck
// parked and the truck driven through the line, seed equal ... his suppression word must not differ either -
// EXCEPT for a team sitting inside the pin radius of a shell that CONNECTED ON THE TRUCK (§11.5)."
//
// Two runs of one seed stepped in lockstep: one with no input at all, one driven forward into the line. Every
// tick, every living man's CLAIM and POSTURE are compared, and every team's TAC_SUPP. The excepted teams are
// tracked honestly rather than assumed: a tick where the driven run's truck lost HP is a connect on the courier,
// and the teams with a living man inside 8 m of the truck at that moment are the ones §11.5 allows to differ.
//
// A difference in claim or posture is a FAULT. A difference in TAC_SUPP on an excepted team is the rule. A
// difference in TAC_SUPP on any other team is a FAULT.
//
// BUT ONLY WHILE THE TWO WARS ARE STILL THE SAME WAR. A driven truck RUNS MEN OVER (§8.2), and from the first
// tick where the two runs hold different men alive everything downstream differs for a reason that has nothing to
// do with a hidden coupling - different men alive means different targets, different rounds, different
// everything. Read without that guard this probe reports 30% of claims differing and says nothing at all. So the
// comparison runs until the living sets part, and reports where that happened.
//
//   node packages/core/tools/measure-parked-vs-driven.mjs [--long]
import { init, step } from '../src/sim.js';
import * as T from '../src/rules/tactics.js';
import * as L from '../src/state.js';

const Q = 65536;
const long = process.argv.includes('--long');
const SEEDS = long ? [1, 2, 3, 4, 5] : [1, 2];
const TICKS = long ? 10800 : 3600;
const PIN_REACH = 8;
const isMan = (i) => (i & L.ARMOUR_MASK) !== 0;

let ticks = 0, manChecks = 0, teamChecks = 0;
let claimDiff = 0, postureDiff = 0, suppDiffExcepted = 0, suppDiffOther = 0;
let connects = 0, exceptedTeamTicks = 0, comparedTicks = 0;
const partedAt = [];
const otherExamples = [];

for (const seed of SEEDS) {
  const A = init(seed), B = init(seed);          // A parked, B driven, same seed
  const a = A.i32, b = B.i32;
  // teams §11.5 has excepted, and the tick from which they are excepted: once a shell has pinned a team the
  // difference persists while it decays, so the exception is sticky rather than one tick wide.
  const excepted = new Set();
  for (let t = 0; t < TICKS; t++) {
    const hpBefore = b[L.O_TRUCK + L.T_HP];
    step(A, 0, 0, 0, 0, 0);                      // parked: no throttle, no steer
    step(B, Q, 0, 0, 0, 0);                      // driven: full throttle, straight on
    ticks++;

    if (b[L.O_TRUCK + L.T_HP] < hpBefore) {      // a shell connected on the courier this tick
      connects++;
      const tx = b[L.O_TRUCK + L.T_X] / Q, tz = b[L.O_TRUCK + L.T_Z] / Q;
      for (let i = 0; i < L.UNITS; i++) {
        if (!isMan(i)) continue;
        const mb = L.O_UNITS + i * L.U_WORDS;
        if (b[mb + L.U_STATE] === 0 || b[mb + L.U_HP] <= 0) continue;
        if (Math.hypot(b[mb + L.U_X] / Q - tx, b[mb + L.U_Z] / Q - tz) > PIN_REACH) continue;
        const rt = T.rifleTeamOf(i);
        excepted.add(`${rt.side}:${rt.team}`);
      }
    }

    // have the two wars parted? the moment one holds a man the other does not, the comparison is over
    let sameWar = true;
    for (let i = 0; i < L.UNITS && sameWar; i++) {
      const mb = L.O_UNITS + i * L.U_WORDS;
      const aliveA = a[mb + L.U_STATE] !== 0 && a[mb + L.U_HP] > 0;
      const aliveB = b[mb + L.U_STATE] !== 0 && b[mb + L.U_HP] > 0;
      if (aliveA !== aliveB) sameWar = false;
    }
    if (!sameWar) { partedAt.push(t); break; }
    comparedTicks++;

    for (let i = 0; i < L.UNITS; i++) {
      if (!isMan(i)) continue;
      const mb = L.O_UNITS + i * L.U_WORDS;
      manChecks++;
      if (T.coverClaim(a, L.O_TACTICS, i) !== T.coverClaim(b, L.O_TACTICS, i)) claimDiff++;
      if (T.coverPosture(a, L.O_TACTICS, i) !== T.coverPosture(b, L.O_TACTICS, i)) postureDiff++;
    }
    for (let sd = 0; sd < 2; sd++)
      for (let f = 0; f < T.FIRE_TEAMS_PER_SIDE; f++) {
        const side = sd === 0 ? -1 : 1;
        teamChecks++;
        const wa = T.suppOf(a, L.O_TACTICS, side, f), wb = T.suppOf(b, L.O_TACTICS, side, f);
        if (wa === wb) continue;
        if (excepted.has(`${side}:${f}`)) { suppDiffExcepted++; exceptedTeamTicks++; }
        else {
          suppDiffOther++;
          if (otherExamples.length < 5) otherExamples.push(`seed ${seed} t ${t} side ${side} team ${f}: parked ${wa}, driven ${wb}`);
        }
      }
  }
}

const pc = (x, y) => `${((100 * x) / Math.max(y, 1)).toFixed(2)}%`;
console.log(`PARKED VERSUS DRIVEN, same seed - ${SEEDS.length} seeds x ${TICKS / 60} s\n`);
console.log(`  ticks compared before the two wars parted   ${comparedTicks} of ${ticks}`);
console.log(`  the tick each seed parted on                ${partedAt.length ? partedAt.join(', ') : 'never'}`);
console.log(`    (a driven truck runs men over, §8.2 - past that point the two wars hold different men and`);
console.log(`     everything downstream differs for that reason, not for a coupling)\n`);
console.log(`  man-ticks compared              ${manChecks}`);
console.log(`    CLAIM differed                ${claimDiff}   (${pc(claimDiff, manChecks)})   <- must be nil`);
console.log(`    POSTURE differed              ${postureDiff}   (${pc(postureDiff, manChecks)})   <- must be nil`);
console.log(`\n  team-ticks compared             ${teamChecks}`);
console.log(`    shells that connected on the truck            ${connects}`);
console.log(`    TAC_SUPP differed on an EXCEPTED team         ${suppDiffExcepted}   (${pc(suppDiffExcepted, teamChecks)})   <- §11.5's exception`);
console.log(`    TAC_SUPP differed on any OTHER team           ${suppDiffOther}   (${pc(suppDiffOther, teamChecks)})   <- must be nil`);
for (const e of otherExamples) console.log(`      ${e}`);
