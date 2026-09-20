// §11.5's SHELL CLAUSE, SIZED BEFORE IT IS BUILT (2026-09-20).
//
// §11.5: "A shell (§4.4) that lands - hit or miss - inside 8 m of a man adds 60 to his team's word too; a tank's
// fire pins infantry, which is what infantry hides from."
//
// WHAT THE OLD ENGINE DOES: nothing to infantry. `Army.cs:631` computes an impact point purely so the tracer does
// not lie - `connects ? at : at + Rand(-5, 5) on each axis` - and hands it to the `Fired` action, which is a
// RENDER hook. There is no suppression, no morale and no infantry effect of any kind in that engine, so there is
// nothing to port and no number to inherit. Two traps in that line if it were copied: the scatter is a per-axis
// Rand, which is the 2-D coupling this core has rejected elsewhere, and taking it would pull two draws out of the
// stream that the core does not currently take.
//
// WHAT THE CORE DOES TODAY: a tank's gun connects or it does not (sim.js), and a connect takes HP off the target
// hull. No impact point is stored, and nothing about a shell reaches a man.
//
// SO THIS SIZES THE HIT HALF, which is the half that is buildable now: a connecting shell lands on the hull it
// hit, and that position is already in the state. The miss half needs a landing point the core does not model and
// belongs with §4.4.
//
// A CONNECT IS READ FROM THE STATE, not guessed: an armour hull whose HP fell this tick, on a tick where no bomb
// blast and no nuke went off (those take HP too, and are counted separately so they cannot be mistaken for guns).
//
//   node packages/core/tools/measure-shell-pin.mjs [--long]
import { init, step, submitLiquidation } from '../src/sim.js';
import * as T from '../src/rules/tactics.js';
import * as L from '../src/state.js';

const Q = 65536;
const long = process.argv.includes('--long');
const SEEDS = long ? [1, 2, 3, 4, 5] : [1, 2];
const WARM = 900, TICKS = long ? 10800 : 2400;
const SHELL_REACH = 8;                                 // §11.5's own 8 m, in metres
const isMan = (i) => (i & L.ARMOUR_MASK) !== 0;

let connects = 0, connectsNearAMan = 0, teamHits = 0, ticks = 0;
let blastTicks = 0, menPerShell = [];
const teamsAlreadyPinned = [0, 0];                     // would the +60 have mattered, or was the team pinned anyway?
let wouldPin = 0, alreadyPinned = 0, wouldNotReach = 0;

for (const seed of SEEDS) {
  const st = init(seed), s = st.i32;
  for (let t = 0; t < WARM; t++) step(st, Q, 0, 0, 0, 0);
  let hp = new Int32Array(L.UNITS);
  for (let i = 0; i < L.UNITS; i++) hp[i] = s[L.O_UNITS + i * L.U_WORDS + L.U_HP];
  let strike = s[L.O_STRIKE + L.K_SERIAL];
  let bombsBefore = [];
  for (let t = 0; t < TICKS; t++) {
    if (t % 1800 === 300) submitLiquidation(st, 4000000);
    const bombs = [];
    for (let k = 0; k < L.MAX_BOMBS; k++) {
      const bb = L.O_BOMBS + k * L.B_WORDS;
      if (s[bb + L.B_STATE] !== 0) bombs.push({ k, x: s[bb + L.B_X] / Q, z: s[bb + L.B_Z] / Q });
    }

    step(st, Q, 0, 0, 0, 0);
    ticks++;

    const nuked = s[L.O_STRIKE + L.K_SERIAL] !== strike;
    if (nuked) strike = s[L.O_STRIKE + L.K_SERIAL];
    const gone = bombsBefore.filter((k) => s[L.O_BOMBS + k.k * L.B_WORDS + L.B_STATE] === 0);
    bombsBefore = bombs;
    const blast = nuked || gone.length > 0;
    if (blast) blastTicks++;

    for (let j = 0; j < L.UNITS; j += 4) {
      const b = L.O_UNITS + j * L.U_WORDS;
      const now = s[b + L.U_HP];
      const fell = now < hp[j];
      hp[j] = now;
      if (!fell) continue;
      // a blast takes HP too; on those ticks a gun cannot be told from a bomb, so they are not counted as shells
      if (blast) continue;
      connects++;
      const sx = s[b + L.U_X] / Q, sz = s[b + L.U_Z] / Q;
      const teams = new Set();
      let n = 0;
      for (let i = 0; i < L.UNITS; i++) {
        if (!isMan(i)) continue;
        const mb = L.O_UNITS + i * L.U_WORDS;
        if (s[mb + L.U_STATE] === 0 || s[mb + L.U_HP] <= 0) continue;
        if (Math.hypot(s[mb + L.U_X] / Q - sx, s[mb + L.U_Z] / Q - sz) > SHELL_REACH) continue;
        n++;
        const rt = T.rifleTeamOf(i);
        teams.add(`${rt.side}:${rt.team}`);
      }
      if (n > 0) { connectsNearAMan++; menPerShell.push(n); }
      for (const key of teams) {
        teamHits++;
        const [sd, f] = key.split(':');
        const side = Number(sd), team = Number(f);
        const w = T.suppOf(s, L.O_TACTICS, side, team);
        if (w >= T.SUPP_PINNED) alreadyPinned++;
        else if (w + T.SUPP_ROUND >= T.SUPP_PINNED) wouldPin++;
        else wouldNotReach++;
      }
    }
  }
}

const pc = (a, b) => `${((100 * a) / Math.max(b, 1)).toFixed(1)}%`;
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
console.log(`§11.5's SHELL CLAUSE, SIZED - ${SEEDS.length} seeds x ${TICKS / 60} s, a nuke every 30 s\n`);
console.log('WHAT EACH ENGINE DOES TODAY');
console.log('  C#    computes an impact point so the tracer does not lie, hands it to a RENDER hook, and does');
console.log('        nothing to infantry with it. No suppression exists in that engine at all.');
console.log('  Core  a gun connects or it does not; a connect takes HP off the hull. No impact point is stored');
console.log('        and nothing about a shell reaches a man.\n');
console.log('THE HIT HALF, WHICH IS WHAT IS BUILDABLE NOW');
console.log(`  shells that connected (blast ticks excluded)   ${connects}`);
console.log(`  ...landing within 8 m of a living man          ${connectsNearAMan}  (${pc(connectsNearAMan, connects)})`);
console.log(`  men inside 8 m when one did, mean              ${mean(menPerShell).toFixed(1)}`);
console.log(`  TEAM-hits it would produce (+60 each)          ${teamHits}`);
console.log(`  ...on a team already pinned (no effect)        ${alreadyPinned}  (${pc(alreadyPinned, teamHits)})`);
console.log(`  ...that would carry a team over the pin line   ${wouldPin}  (${pc(wouldPin, teamHits)})`);
console.log(`  ...that would not reach the line even so       ${wouldNotReach}  (${pc(wouldNotReach, teamHits)})`);
console.log(`\n  ticks excluded because a bomb or nuke went off ${blastTicks} of ${ticks}  (${pc(blastTicks, ticks)})`);
