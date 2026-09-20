// §11.5's PINNED SHARE. Written 2026-09-20 as step one, when no TAC_SUPP word existed and the share had to be
// DERIVED from the rounds the core already fired. Since 2383c95b the word EXISTS and --live reads it straight out
// of the core, which is the closed-loop reading; without --live the tool still derives, which is what the
// before-and-after comparison needs. It writes nothing either way.
//
// §0's row: "each side has at least one pinned fire team on 10% to 70% of ticks". It is a BAND - a bare chart
// fails it and so does a front where everyone is permanently face-down - so the question is not "is there any
// suppression" but "where does today's fire volume land". That can be answered before a word is written, because
// §11.5's accumulator is a pure function of rounds already being fired:
//
//   +60 per round aimed at one of the team's living men, -1 per tick, clamped [0, 600]
//   under fire  TAC_SUPP > 0        pinned  TAC_SUPP >= 120
//
// HOW A ROUND IS SEEN FROM OUTSIDE, exactly and not approximately. A rifleman acts on the tick his U_COOLDOWN
// reaches 0, and the cooldown he is handed afterwards says what he did: a reload of 150-269 ticks (2.5-4.5 s) if
// he fired at a man, a look-again of 24-65 ticks (0.4-1.1 s) if he had no target. The two ranges do not overlap,
// so "did he fire a round at a man this tick" is exact. Which man he fired at is re-derived with the core's own
// `pickRifleTarget` on the post-step positions; that can differ from the core's pick in rare ordering cases, and
// it only ever moves a +60 between two teams of the same side, so the per-side share below is robust to it.
//
// TWO READINGS, because they answer different questions:
//   (1) TODAY'S FIRE ALONE - only the rounds the core already fires.
//   (2) WITH §11.5's SUPPRESSING ROUNDS - a man with no rifle target inside 26 m (§8.1) but a living enemy MAN
//       inside 34 m fires a round that never hits and adds 60 to that man's team. That 34 m is this letter's own
//       number: C#'s `CourierRange = 34f` is the range at which a rifleman engages the TRUCK and is a different
//       quantity that happens to share a digit. Core gets its own named constant.
//
// WITH --live THE WORD IS NOT DERIVED AT ALL: it is read straight out of the core, which is the closed-loop
// reading - a pinned team does not rush and a pinned man fires at half rate, so the round volume that produced the
// pinning falls. That feedback is the only thing that can bring the open-loop 83% back toward §0's band, and it
// cannot be predicted from outside, only measured.
//
//   node packages/core/tools/measure-suppression.mjs [--long] [--scroll] [--live]
import { init, step, submitLiquidation, submitSample } from '../src/sim.js';
import { pickRifleTarget, RIFLE_RANGE } from '../src/rules/army.js';
import * as T from '../src/rules/tactics.js';
import * as L from '../src/state.js';

const Q = 65536;
const long = process.argv.includes('--long');
const SCROLL = process.argv.includes('--scroll');
const LIVE = process.argv.includes('--live');
const SEEDS = long ? [1, 2, 3, 4, 5] : [1, 2];
const WARM = 900, TICKS = long ? 10800 : 2400;

const SUPP_ADD = 60, SUPP_MAX = 600, SUPP_PINNED = 120;
const SUPPRESS_REACH = Math.imul(34, Q);       // §11.5's own: how far a man fires at an enemy MAN he cannot target
const RELOAD_LO = 150, RELOAD_HI = 269;        // he fired at a man
const LOOK_LO = 24, LOOK_HI = 65;              // he had no target and looked again
const STEP_MIN = 655;                          // §11.4's 0.01 m
const isMan = (i) => (i & L.ARMOUR_MASK) !== 0;
const teams = L.UNITS;                         // indexed by [sideBit][team]

function run(withSuppressing) {
  let ticks = 0;
  const pinnedTicks = [0, 0], underTicks = [0, 0];
  const pinnedTeamTicks = [0, 0], teamTicks = [0, 0];
  let rounds = 0, suppRounds = 0;
  let standPinned = 0, standAll = 0, downAll = 0;
  for (const seed of SEEDS) {
    const st = init(seed), s = st.i32;
    for (let t = 0; t < WARM; t++) step(st, Q, 0, 0, 0, 0);
    const supp = [new Int32Array(T.FIRE_TEAMS_PER_SIDE), new Int32Array(T.FIRE_TEAMS_PER_SIDE)];
    for (let t = 0; t < TICKS; t++) {
      if (t % 1800 === 300) submitLiquidation(st, 4000000);
      if (SCROLL && t % 300 === 150) submitSample(st, (st.tape[st.tape.length - 1] - 400) | 0);

      const acting = [];
      if (LIVE) {                                   // count what the core itself fires, half-rate included
        for (let i = 0; i < L.UNITS; i++) {
          if (!isMan(i)) continue;
          const b = L.O_UNITS + i * L.U_WORDS;
          if (s[b + L.U_STATE] === 0 || s[b + L.U_HP] <= 0) continue;
          if (s[b + L.U_COOLDOWN] === 0) acting.push(i);
        }
      }
      const was = new Map();
      for (let i = 0; i < L.UNITS; i++) {
        if (!isMan(i)) continue;
        const b = L.O_UNITS + i * L.U_WORDS;
        if (s[b + L.U_STATE] === 0 || s[b + L.U_HP] <= 0) continue;
        was.set(i, [s[b + L.U_X], s[b + L.U_Z]]);
        if (!LIVE && s[b + L.U_COOLDOWN] === 0) acting.push(i);
      }

      step(st, Q, 0, 0, 0, 0);

      if (LIVE) {
        for (let sd = 0; sd < 2; sd++)
          for (let f = 0; f < T.FIRE_TEAMS_PER_SIDE; f++) supp[sd][f] = T.suppOf(s, L.O_TACTICS, sd === 0 ? -1 : 1, f);
        for (const i of acting) {
          const b = L.O_UNITS + i * L.U_WORDS;
          if (s[b + L.U_STATE] === 0) continue;
          if (s[b + L.U_COOLDOWN] >= RELOAD_LO) rounds++;      // a reload, his own or a pinned man's doubled one
        }
      } else {
        // decay first, as the word is read at the top of a tick and written on the shooter's
        for (let sd = 0; sd < 2; sd++)
          for (let f = 0; f < T.FIRE_TEAMS_PER_SIDE; f++) if (supp[sd][f] > 0) supp[sd][f] = (supp[sd][f] - 1) | 0;
      }

      // pickRifleTarget takes a unit VIEW, not a word reader (army.js:1074)
      const peekAt = (j) => { const jb = L.O_UNITS + j * L.U_WORDS;
        return { x: s[jb + L.U_X], z: s[jb + L.U_Z], hp: s[jb + L.U_STATE] === 0 ? 0 : s[jb + L.U_HP],
                 side: s[jb + L.U_SIDE], armour: !isMan(j) }; };
      for (const i of LIVE ? [] : acting) {
        const b = L.O_UNITS + i * L.U_WORDS;
        if (s[b + L.U_STATE] === 0) continue;
        const cd = s[b + L.U_COOLDOWN];
        const fired = cd >= RELOAD_LO && cd <= RELOAD_HI;
        const looked = cd >= LOOK_LO && cd <= LOOK_HI;
        if (fired) {
          const foe = pickRifleTarget(peekAt, L.UNITS, i, s[b + L.U_X], s[b + L.U_Z], s[b + L.U_SIDE]);
          if (foe >= 0 && isMan(foe)) {
            const rt = T.rifleTeamOf(foe), sd = rt.side < 0 ? 0 : 1;
            supp[sd][rt.team] = Math.min(SUPP_MAX, supp[sd][rt.team] + SUPP_ADD);
            rounds++;
          }
        } else if (looked && withSuppressing) {
          // §11.5: no rifle target inside 26 m, but a living enemy MAN inside 34 m - the nearest one takes it
          let best = -1, bestD = 0;
          for (let j = 0; j < L.UNITS; j++) {
            if (!isMan(j)) continue;
            const jb = L.O_UNITS + j * L.U_WORDS;
            if (s[jb + L.U_STATE] === 0 || s[jb + L.U_HP] <= 0) continue;
            if ((s[jb + L.U_SIDE] < 0) === (s[b + L.U_SIDE] < 0)) continue;
            const dx = Math.abs(s[jb + L.U_X] - s[b + L.U_X]), dz = Math.abs(s[jb + L.U_Z] - s[b + L.U_Z]);
            if (dx > SUPPRESS_REACH || dz > SUPPRESS_REACH) continue;
            const d = Math.hypot(dx / Q, dz / Q);
            if (d > 34) continue;
            if (best < 0 || d < bestD) { best = j; bestD = d; }
          }
          if (best >= 0) {
            const rt = T.rifleTeamOf(best), sd = rt.side < 0 ? 0 : 1;
            supp[sd][rt.team] = Math.min(SUPP_MAX, supp[sd][rt.team] + SUPP_ADD);
            suppRounds++;
          }
        }
      }

      ticks++;
      for (let sd = 0; sd < 2; sd++) {
        // THE ROW IS THE SHARE OF TEAMS (ruled 2026-09-20). This tool first counted "at least one of nine teams
        // pinned" and reported 96% as an overage; that is an OR, not a share, and at 43.8% per team an OR of nine
        // is 99.5% by arithmetic alone. Both are printed now, the share as the row and the OR labelled as what it
        // is, so the same misreading cannot be made from this output again.
        let anyPinned = false, anyUnder = false;
        for (let f = 0; f < T.FIRE_TEAMS_PER_SIDE; f++) {
          if (supp[sd][f] >= SUPP_PINNED) { anyPinned = true; pinnedTeamTicks[sd]++; }
          if (supp[sd][f] > 0) anyUnder = true;
          teamTicks[sd]++;
        }
        if (anyPinned) pinnedTicks[sd]++;
        if (anyUnder) underTicks[sd]++;
      }

      // WHAT §11.5 WOULD DO TO §11.4's 2x REMAINDER: a pinned man does not rush, so every STAND man-tick that
      // belongs to a pinned team becomes PRONE or COVER. Both sides of the ratio move, and this counts how much.
      for (const [i, b4] of was) {
        const b = L.O_UNITS + i * L.U_WORDS;
        if (s[b + L.U_STATE] === 0 || s[b + L.U_HP] <= 0) continue;
        const moved = Math.abs(s[b + L.U_X] - b4[0]) + Math.abs(s[b + L.U_Z] - b4[1]);
        const rt = T.rifleTeamOf(i), sd = rt.side < 0 ? 0 : 1;
        if (moved > STEP_MIN) { standAll++; if (supp[sd][rt.team] >= SUPP_PINNED) standPinned++; } else downAll++;
      }
    }
  }
  return { ticks, pinnedTicks, underTicks, pinnedTeamTicks, teamTicks, rounds, suppRounds, standPinned, standAll, downAll };
}

const pc = (a, b) => `${((100 * a) / Math.max(b, 1)).toFixed(1)}%`;
console.log(`§11.5 PINNED SHARE - ${LIVE ? "READ from the core's own TAC_SUPP word" : 'DERIVED, the word not read'} - ${SEEDS.length} seeds x ${TICKS / 60} s, a nuke every 30 s, tape ${SCROLL ? 'SCROLLING' : 'FROZEN'}`);
console.log(`  §0's row is the SHARE OF TEAMS pinned, 10% to 70% - a band, not a floor, and NOT the fraction of ticks`);
console.log(`  on which at least one of nine teams is pinned (ruled 2026-09-20; that OR saturates by arithmetic)\n`);
const cases = LIVE ? [['CLOSED LOOP - the core\'s own TAC_SUPP word', false]]
                   : [['(1) TODAY\'S RIFLE FIRE ALONE', false], ['(2) WITH §11.5 SUPPRESSING ROUNDS (34 m)', true]];
for (const [name, withS] of cases) {
  const r = run(withS);
  console.log(`${name}`);
  console.log(`   rounds counted        ${r.rounds}${withS ? `   suppressing rounds ${r.suppRounds}` : ''}`);
  console.log(`   THE ROW - share of TEAMS pinned:  bulls ${pc(r.pinnedTeamTicks[0], r.teamTicks[0])}   bears ${pc(r.pinnedTeamTicks[1], r.teamTicks[1])}   (the 10-70 band)`);
  console.log(`   for reference only, the OR of nine teams: bulls ${pc(r.pinnedTicks[0], r.ticks)}  bears ${pc(r.pinnedTicks[1], r.ticks)}  - NOT the row`);
  console.log(`   under fire (any team)  bulls ${pc(r.underTicks[0], r.ticks)}   bears ${pc(r.underTicks[1], r.ticks)}`);
  const lo = Math.min(...[0, 1].map((k) => (100 * r.pinnedTeamTicks[k]) / Math.max(r.teamTicks[k], 1)));
  const hi = Math.max(...[0, 1].map((k) => (100 * r.pinnedTeamTicks[k]) / Math.max(r.teamTicks[k], 1)));
  console.log(`   -> ${lo >= 10 && hi <= 70 ? 'INSIDE the 10-70 band' : lo < 10 ? 'UNDER the band' : 'OVER the band'}`);
  console.log(`   STAND man-ticks on a PINNED team  ${r.standPinned} of ${r.standAll} standing (${pc(r.standPinned, r.standAll)})`);
  console.log(`     those would become PRONE or COVER under §11.5, moving both sides of §11.4's 2x ratio:`);
  console.log(`     STAND ${r.standAll} -> ${r.standAll - r.standPinned},  down ${r.downAll} -> ${r.downAll + r.standPinned}\n`);
}
