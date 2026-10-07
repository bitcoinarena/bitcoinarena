// THE CHAIN THE RENDERER NOW DRAWS FROM (2026-09-20). ArmyRenderer reads two core words and poses from them:
// §11.4's posture in TAC_COVER's high bits, and §11.5's pin in TAC_SUPP. This checks the CORE half of that chain
// on the case the clause exists for - a shell connecting on the cab - so the drawing has something true to read.
//
// The renderer's rule is `down = posture != STAND`. So what has to hold is: a man inside 8 m of a cab hit, whose
// team the shell pins, is written PRONE or COVER and not STAND. The C# half is a pose; this is the word it reads.
//
//   node packages/nextblock/tools/measure-pin-pose.mjs
import { init, step, teleport } from '../src/sim.js';
import { APRON_RADIUS } from '../src/rules/score.js';
import { START_X } from '../src/sim.js';
import * as T from '../src/rules/tactics.js';
import * as L from '../src/state.js';

const Q = 65536, isMan = (i) => (i & L.ARMOUR_MASK) !== 0;
let connects = 0, menNear = 0, menDown = 0, menStand = 0, pinnedTeams = 0;

for (const seed of [1, 2, 3]) {
  const st = init(seed), s = st.i32;
  for (let t = 0; t < 900; t++) step(st, Q, 0, 0, 0, 0);
  let tank = -1, foe = -1;
  for (let j = 0; j < L.UNITS; j += 4) {
    const b = L.O_UNITS + j * L.U_WORDS;
    if (s[b + L.U_STATE] === 0 || s[b + L.U_HP] <= 0) continue;
    if (tank < 0) { tank = j; continue; }
    if (foe < 0 && (s[b + L.U_SIDE] < 0) !== (s[L.O_UNITS + tank * L.U_WORDS + L.U_SIDE] < 0)) { foe = j; break; }
  }
  if (tank < 0 || foe < 0) continue;
  const tb = L.O_UNITS + tank * L.U_WORDS, fb = L.O_UNITS + foe * L.U_WORDS;
  const team = [];
  for (let i = 0; i < L.UNITS; i++) {
    if (!isMan(i)) continue;
    const mb = L.O_UNITS + i * L.U_WORDS;
    if (team.length < 4 && s[mb + L.U_STATE] !== 0 && s[mb + L.U_HP] > 0
        && (s[mb + L.U_SIDE] < 0) === (s[tb + L.U_SIDE] < 0)) { team.push(i); continue; }
    s[mb + L.U_STATE] = 0; s[mb + L.U_HP] = 0;
  }
  for (let j = 0; j < L.UNITS; j += 4) {
    if (j === tank || j === foe) continue;
    const b = L.O_UNITS + j * L.U_WORDS;
    s[b + L.U_STATE] = 0; s[b + L.U_HP] = 0;
  }
  s[fb + L.U_X] = s[tb + L.U_X] + Math.imul(40, Q);

  for (let t = 0; t < 900; t++) {
    s[L.O_SCORE + L.S_BESTX] = START_X + APRON_RADIUS + Q;
    teleport(st, s[tb + L.U_X] + Math.imul(6, Q), s[tb + L.U_Z], 0);
    s[L.O_TRUCK + L.T_HP] = Q * 100;
    for (const i of team) {
      const mb = L.O_UNITS + i * L.U_WORDS;
      s[mb + L.U_X] = s[L.O_TRUCK + L.T_X] + Math.imul(2, Q);
      s[mb + L.U_Z] = s[L.O_TRUCK + L.T_Z] + Math.imul(2, Q);
    }
    const hpBefore = s[L.O_TRUCK + L.T_HP];
    step(st, Q, 0, 0, 0, 0);
    if (s[L.O_TRUCK + L.T_HP] < hpBefore) connects++;
    // ONE CAB HIT IS NOT A PIN. A shell adds 60 and the line is 120 - §11.5's own "two rounds to pin from cold",
    // and they must land inside 60 ticks of each other. Checking the tick after a single hit measures a team
    // that is under fire and not pinned, which is exactly what the first version of this tool did: it reported
    // 8 of 8 men drawn upright and read as a renderer fault when it was the arithmetic. So wait for the word to
    // cross the line, then look at what the renderer would draw.
    const rt0 = T.rifleTeamOf(team[0]);
    if (!T.isPinned(s, L.O_TACTICS, rt0.side, rt0.team)) continue;
    const tx = s[L.O_TRUCK + L.T_X] / Q, tz = s[L.O_TRUCK + L.T_Z] / Q;
    for (const i of team) {
      const mb = L.O_UNITS + i * L.U_WORDS;
      if (s[mb + L.U_STATE] === 0 || s[mb + L.U_HP] <= 0) continue;
      if (Math.hypot(s[mb + L.U_X] / Q - tx, s[mb + L.U_Z] / Q - tz) > 8) continue;
      menNear++;
      const rt = T.rifleTeamOf(i);
      if (T.isPinned(s, L.O_TACTICS, rt.side, rt.team)) pinnedTeams++;
      if (T.coverPosture(s, L.O_TACTICS, i) === T.POSTURE_STAND) menStand++; else menDown++;
    }
    break;
  }
}

const pc = (a, b) => `${((100 * a) / Math.max(b, 1)).toFixed(1)}%`;
console.log('THE WORD THE RENDERER READS, on a shell connecting on the cab (3 constructed seeds)\n');
console.log(`  cab hits seen                       ${connects}   (a shell is +60; the pin line is 120, so one hit alone never pins)`);
console.log(`  men inside 8 m of the hit            ${menNear}`);
console.log(`    their team PINNED                  ${pinnedTeams}  (${pc(pinnedTeams, menNear)})`);
console.log(`    written PRONE or COVER - drawn DOWN ${menDown}  (${pc(menDown, menNear)})`);
console.log(`    written STAND - drawn UPRIGHT       ${menStand}  (${pc(menStand, menNear)})   <- must be nil`);
console.log(`\n  ArmyRenderer poses on \`posture != STAND\`, so the last line is what would still be drawn walking.`);
