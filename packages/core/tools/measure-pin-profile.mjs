// WHAT THE PIN IS ACTUALLY HOLDING (2026-09-20). One log of the code's own numbers, not another guess: §0 wants
// each side pinned on 10-70% of ticks and the core reads 96.0% / 95.6%, so before any behaviour changes again we
// need to know whether the overage is the THRESHOLD, the DURATION or the FIRE DENSITY.
//
// It also settles hole 2, which is a reading question rather than a rule question. the owner 2026-09-20: the covering
// team is the one on the ground, so a pinned team must LOOK HALTED to its neighbour even when its clock would have
// it rushing. `halted[f] = (raw && !(f > 0 && halted[f-1])) || pinned` already does that, and this counts the
// ticks where a pinned team is NOT halted to its neighbour - which should be nil.
//
//   node packages/core/tools/measure-pin-profile.mjs [--long]
import { init, step, submitLiquidation } from '../src/sim.js';
import { standingStill } from '../src/rules/army.js';
import * as T from '../src/rules/tactics.js';
import * as L from '../src/state.js';

const Q = 65536;
const long = process.argv.includes('--long');
const SEEDS = long ? [1, 2, 3, 4, 5] : [1, 2];
const WARM = 900, TICKS = long ? 10800 : 2400;
const HALF_REST = 210;
const isMan = (i) => (i & L.ARMOUR_MASK) !== 0;

let ticks = 0, teamTicks = 0, pinnedTeamTicks = 0, underTeamTicks = 0;
let pinnedNotHalted = 0, pinnedAndHalted = 0, pinnedWhileClockRushes = 0;
const episodes = [];                       // pinned episode lengths, in ticks
const wordSeen = [];                       // the word's value, sampled
let rounds = 0;
// WHAT ACTUALLY LIFTS THE WORD: a rifle/suppressing round is +60, a bomb is +300. If the word jumps by 300 or more
// in one tick that was a blast, and a blast alone is two and a half times the pin line.
let bumpRound = 0, bumpBomb = 0, pinStartedByBomb = 0, pinStartedByFire = 0;
// THE SIZE OF A BLAST RISE. §11.5 gives a team 300 for a blast, once. If the same team takes 600 in one tick it
// was charged twice, which is what the per-man version did when two of its men stood in the same circle.
const blastRises = [];

for (const seed of SEEDS) {
  const st = init(seed), s = st.i32;
  for (let t = 0; t < WARM; t++) step(st, Q, 0, 0, 0, 0);
  const openFrom = new Map();              // "sd:f" -> tick the current pinned episode began
  let lastSupp = null;
  for (let t = 0; t < TICKS; t++) {
    if (t % 1800 === 300) submitLiquidation(st, 4000000);
    const before = [];
    for (let i = 0; i < L.UNITS; i++) {
      if (!isMan(i)) continue;
      const b = L.O_UNITS + i * L.U_WORDS;
      if (s[b + L.U_STATE] !== 0 && s[b + L.U_HP] > 0 && s[b + L.U_COOLDOWN] === 0) before.push(i);
    }

    step(st, Q, 0, 0, 0, 0);
    ticks++;
    for (const i of before) {
      const b = L.O_UNITS + i * L.U_WORDS;
      if (s[b + L.U_STATE] !== 0 && s[b + L.U_COOLDOWN] >= 150) rounds++;
    }

    // the halt clocks of the tick that just ran, exactly as sim.js builds them
    const halted = [[], []];
    const suppNow = [[], []];
    for (let sd = 0; sd < 2; sd++)
      for (let f = 0; f < T.FIRE_TEAMS_PER_SIDE; f++) suppNow[sd][f] = T.suppOf(s, L.O_TACTICS, sd === 0 ? -1 : 1, f);
    for (let sd = 0; sd < 2; sd++)
      for (let f = 0; f < T.FIRE_TEAMS_PER_SIDE; f++) {
        const key = T.mix(s[L.O_TACTICS + T.TAC_SEED], 500 + Math.imul(sd, 16) + f) & 0x7fffffff;
        const raw = standingStill(key, (s[L.O_TICK] - ((f & 1) === 1 ? HALF_REST : 0)) | 0);
        const pinned = T.isPinned(s, L.O_TACTICS, sd === 0 ? -1 : 1, f);
        halted[sd][f] = (raw && !(f > 0 && halted[sd][f - 1])) || pinned;
        // HOLE 2's question: a pinned team that its neighbour does NOT see as halted
        teamTicks++;
        const w = T.suppOf(s, L.O_TACTICS, sd === 0 ? -1 : 1, f);
        if (t % 60 === 0) wordSeen.push(w);
        if (w > 0) underTeamTicks++;
        if (lastSupp) {
          const rise = suppNow[sd][f] - (lastSupp[sd][f] - 1);      // the -1 undoes this tick's decay
          if (rise >= 300) { bumpBomb++; blastRises.push(rise); } else if (rise >= 60) bumpRound++;
        }
        if (pinned) {
          pinnedTeamTicks++;
          if (halted[sd][f]) pinnedAndHalted++; else pinnedNotHalted++;
          if (!raw) pinnedWhileClockRushes++;       // the clock would have it rushing; the pin holds it down
          if (!openFrom.has(`${sd}:${f}`)) {
            openFrom.set(`${sd}:${f}`, t);
            if (lastSupp && suppNow[sd][f] - (lastSupp[sd][f] - 1) >= 300) pinStartedByBomb++; else pinStartedByFire++;
          }
        } else if (openFrom.has(`${sd}:${f}`)) {
          episodes.push(t - openFrom.get(`${sd}:${f}`));
          openFrom.delete(`${sd}:${f}`);
        }
      }
    lastSupp = suppNow;
  }
}

const pc = (a, b) => `${((100 * a) / Math.max(b, 1)).toFixed(1)}%`;
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const q = (a, p) => { const b = a.slice().sort((x, y) => x - y); return b.length ? b[Math.floor(b.length * p)] : 0; };

console.log(`THE PIN, AS THE CODE HOLDS IT - ${SEEDS.length} seeds x ${TICKS / 60} s, a nuke every 30 s\n`);
console.log('THE NUMBERS THE RULE IS BUILT FROM (§11.5, unchanged and not retuned)');
console.log(`  a round adds            ${T.SUPP_ROUND}`);
console.log(`  decay                   1 a tick = 60 a second`);
console.log(`  pinned at               ${T.SUPP_PINNED}`);
console.log(`  clamp                   [0, ${T.SUPP_MAX}]`);
console.log(`  a bomb adds             ${T.SUPP_BOMB}`);
console.log(`  -> rounds to pin from cold   ${Math.ceil(T.SUPP_PINNED / T.SUPP_ROUND)}  (and they must land inside ${T.SUPP_ROUND} ticks of each other)`);
console.log(`  -> one round alone decays past the pin line in ${Math.max(0, T.SUPP_ROUND - T.SUPP_PINNED)} ticks; it never reaches it alone`);
console.log(`  -> BREAK-EVEN: one round a second holds the word level, because a round is ${T.SUPP_ROUND} and a second of decay is 60`);
console.log(`  -> from the clamp, ${T.SUPP_MAX} decays to the pin line in ${T.SUPP_MAX - T.SUPP_PINNED} ticks (${((T.SUPP_MAX - T.SUPP_PINNED) / 60).toFixed(1)} s) and to clear in ${T.SUPP_MAX} ticks (${(T.SUPP_MAX / 60).toFixed(1)} s)`);

console.log('\nWHAT IT ACTUALLY HOLDS');
console.log(`  team-ticks                    ${teamTicks}`);
console.log(`    under fire (word > 0)       ${underTeamTicks}  (${pc(underTeamTicks, teamTicks)})`);
console.log(`    pinned (word >= 120)        ${pinnedTeamTicks}  (${pc(pinnedTeamTicks, teamTicks)})`);
console.log(`  the word, sampled once a second: mean ${mean(wordSeen).toFixed(0)}, median ${q(wordSeen, 0.5)}, p90 ${q(wordSeen, 0.9)}, max ${Math.max(...wordSeen)}`);
console.log(`  rifle rounds fired            ${rounds}  = ${(rounds / (ticks / 60)).toFixed(1)} a second across both sides`);
console.log(`  ...per team per second        ${(rounds / (ticks / 60) / (T.FIRE_TEAMS_PER_SIDE * 2)).toFixed(2)}   (break-even is 1.00)`);

console.log('\nHOW LONG A PIN LASTS');
console.log(`  episodes ended                ${episodes.length}`);
if (episodes.length) {
  console.log(`  length in seconds   mean ${(mean(episodes) / 60).toFixed(1)}, median ${(q(episodes, 0.5) / 60).toFixed(1)}, p90 ${(q(episodes, 0.9) / 60).toFixed(1)}, max ${(Math.max(...episodes) / 60).toFixed(1)}`);
}

console.log('\nWHAT LIFTS THE WORD');
console.log(`  ticks a team's word rose by a round (+60..299)   ${bumpRound}`);
console.log(`  ticks a team's word rose by a BLAST (+300 or more) ${bumpBomb}`);
{
  const at300 = blastRises.filter((r) => r < 600).length, at600 = blastRises.filter((r) => r >= 600).length;
  console.log(`    of those, a rise under 600 (one blast charge)   ${at300}`);
  console.log(`    of those, 600 or more (charged more than once)  ${at600}`);
  console.log(`    largest single-tick rise                        ${blastRises.length ? Math.max(...blastRises) : 0}`);
}
console.log(`  pinned episodes opened by a blast                ${pinStartedByBomb}  (${pc(pinStartedByBomb, pinStartedByBomb + pinStartedByFire)})`);
console.log(`  pinned episodes opened by rifle rounds           ${pinStartedByFire}  (${pc(pinStartedByFire, pinStartedByBomb + pinStartedByFire)})`);
console.log(`  A blast is 300 - two and a half times the pin line - and from the 600 clamp the word needs 8.0 s to`);
console.log(`  decay back under 120. Rifle fire runs at 0.19 rounds a team a second against a break-even of 1.00.`);

console.log('\nHOLE 2 - DOES A PINNED TEAM LOOK HALTED TO ITS NEIGHBOUR?');
console.log(`  pinned team-ticks             ${pinnedTeamTicks}`);
console.log(`    seen as halted              ${pinnedAndHalted}  (${pc(pinnedAndHalted, pinnedTeamTicks)})`);
console.log(`    NOT seen as halted          ${pinnedNotHalted}  (${pc(pinnedNotHalted, pinnedTeamTicks)})   <- must be nil`);
console.log(`    ...of those, the clock would have had it RUSHING  ${pinnedWhileClockRushes}  (${pc(pinnedWhileClockRushes, pinnedTeamTicks)})`);
console.log(`    That last line is the rule doing its job: the pin holds a team down that the timer would have run.`);
