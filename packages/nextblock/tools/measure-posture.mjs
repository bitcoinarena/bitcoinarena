// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// §11.4's POSTURE MIX. Written 2026-09-19 as step one of the letter, when the core held no posture and the mix
// had to be DERIVED from state. Since 7bc7c1f6 the core WRITES posture into TAC_COVER's high bits, so this tool
// now derives the mix AND reads the written word, and prints how often the two agree - the gap being the rifle's
// deliberate one-tick lag. It still writes nothing itself.
//
// §0's "Men hide" row grades man-ticks of living men ON THE LINE - within 40 m of their post - who did NOT step:
// at least 85% of them must be PRONE or COVER. Nothing in the core writes a posture yet, so the row is undone; but
// the posture §11.4 defines is DERIVED, not chosen, so it can be computed from the state the core already has and
// the row can be given a number before a single bit is written.
//
// §11.4's own derivation, taken literally:
//   STAND  his own step this tick is over 0.01 m in x + z - a rush leg, a walk to his post or his place, a column
//   COVER  within 0.5 m of the place he claims (§11.3), and not stepping
//   PRONE  everything else that did not step - a halt on the line in the open, a man on a post that has not moved
//
// Two things this tool is careful about:
//
// A PUSH IS NOT A STEP. §8.3's hull clearance stands a man exactly 3 m off a living tank after his own step, and
// §3's replacement walks in from the back edge. Neither is the man's own gait. The raw reading and the corrected
// one are both printed, because the difference decides whether "Men hide" is a real number or an artefact.
//
// THE SECOND FODDER CLAUSE NEEDS A BASELINE TOO. §0 wants rifle deaths per man-tick of STAND men to be at least
// twice those of PRONE and COVER together. Today every posture is shot on the same flat threshold, so the ratio
// should sit near 1.0 - that is the "before" this letter has to move, and it is printed here.
//
//   node packages/nextblock/tools/measure-posture.mjs [--scroll]
//
// With --scroll a price sample is submitted every 5 s, which is the game; without it the tape is frozen, which is
// the drive the §11.3 assert runs on. Both are reported because the two differ and the letter is graded on both.
import { init, step, submitLiquidation, submitSample, frontAt } from '../src/sim.js';
import { riflePost } from '../src/rules/army.js';
import * as T from '../src/rules/tactics.js';
import * as L from '../src/state.js';

const Q = 65536;
const SCROLL = process.argv.includes('--scroll');
const long = process.argv.includes('--long');          // five seeds x 180 s, to give the death split a sample
const SEEDS = long ? [1, 2, 3, 4, 5] : [1, 2];
const WARM = 900, TICKS = long ? 10800 : 2400;
const STEP_MIN = Math.round(Q / 100);                  // §11.4's 0.01 m, so a crawl is not a step
// EUCLIDEAN, ON SQUARES (WAR_TACTICS §4.16, ruled 2026-09-22) - the same compare the core makes, so the
// probe and the rule cannot drift. This read |dx| + |dz|, 41% larger on a diagonal.
const STEP_MIN2 = STEP_MIN * STEP_MIN;
const ON_PLACE = Q >> 1;                               // 0.5 m
const ON_LINE = Math.imul(40, Q);                      // §0's "on the line": within 40 m of his post
const isMan = (i) => (i & L.ARMOUR_MASK) !== 0;
const SQUADS_PER_SIDE = (L.SQUAD_WORDS / 2) | 0;
const squadWord = (side, k) => L.O_SQUADS + (side < 0 ? k : SQUADS_PER_SIDE + k);
const HULL_CLEAR = 3.05;                               // §8.3, the push that is not a step

let onLine = 0, didNotStep = 0, stand = 0, prone = 0, cover = 0;
let standRaw = 0, pushed = 0, openNotStepped = 0, openProne = 0;
let manTicks = 0, allStand = 0, allProne = 0, allCover = 0;
const deaths = { STAND: 0, PRONE: 0, COVER: 0 }, tickOf = { STAND: 0, PRONE: 0, COVER: 0 };
// THE LETTER'S OWN "MEN HIDE": of man-ticks on which a man HOLDS a cover claim, how many are not STAND. Occupancy
// closed in §11.3; what §11.4 owns is that a man who has a hole is written down as being in it.
const heldBy = { STAND: 0, PRONE: 0, COVER: 0 };
let heldTicks = 0, writtenAgrees = 0, writtenSeen = 0;
const NAME = ['STAND', 'PRONE', 'COVER'];

for (const seed of SEEDS) {
  const st = init(seed), s = st.i32;
  for (let t = 0; t < WARM; t++) step(st, Q, 0, 0, 0, 0);
  let bombsBefore = [];
  let strike = s[L.O_STRIKE + L.K_SERIAL];
  for (let t = 0; t < TICKS; t++) {
    if (t % 1800 === 300) submitLiquidation(st, 4000000);
    if (SCROLL && t % 300 === 150) submitSample(st, (st.tape[st.tape.length - 1] - 400) | 0);

    const was = new Map();
    for (let i = 0; i < L.UNITS; i++) {
      if (!isMan(i)) continue;
      const b = L.O_UNITS + i * L.U_WORDS;
      if (s[b + L.U_STATE] === 0 || s[b + L.U_HP] <= 0) continue;
      // THE CLAIM IS READ BEFORE THE STEP. A dead man's claim is cleared the tick he dies (§11.3), so reading it
      // afterwards makes COVER structurally impossible for a casualty and files every man killed in a hole under
      // PRONE. Measured with that fault: 0 COVER deaths in 548,070 COVER man-ticks, which is a tool artefact and
      // not the world. What a man is graded on is the posture he HELD while he was being shot at.
      const idNow = T.coverClaim(s, L.O_TACTICS, i);
      let placed = false;
      if (idNow !== T.COVER_NONE) {
        const pp = T.coverPlace(s, idNow, s[b + L.U_SIDE] < 0 ? -1 : 1,
                                st.candles && !st.noCandleField ? st.candles : null, st.candleShift | 0);
        if (pp) placed = Math.hypot((s[b + L.U_X] - pp.x) / Q, (s[b + L.U_Z] - pp.z) / Q) <= ON_PLACE / Q;
      }
      was.set(i, [s[b + L.U_X], s[b + L.U_Z], idNow, placed]);
    }
    const bombs = [];
    for (let k = 0; k < L.MAX_BOMBS; k++) {
      const bb = L.O_BOMBS + k * L.B_WORDS;
      if (s[bb + L.B_STATE] !== 0) bombs.push({ k, x: s[bb + L.B_X] / Q, z: s[bb + L.B_Z] / Q });
    }

    step(st, Q, 0, 0, 0, 0);

    const nuked = s[L.O_STRIKE + L.K_SERIAL] !== strike;
    if (nuked) strike = s[L.O_STRIKE + L.K_SERIAL];
    const nx = s[L.O_STRIKE + L.K_X] / Q, nz = s[L.O_STRIKE + L.K_Z] / Q;
    const gone = bombsBefore.filter((k) => s[L.O_BOMBS + k.k * L.B_WORDS + L.B_STATE] === 0);
    bombsBefore = bombs;

    for (const [i, b4] of was) {
      const b = L.O_UNITS + i * L.U_WORDS;
      const alive = s[b + L.U_STATE] !== 0 && s[b + L.U_HP] > 0;
      const mdx = s[b + L.U_X] - b4[0]; const mdz = s[b + L.U_Z] - b4[1];
      const moved2 = mdx * mdx + mdz * mdz;

      // his own step, or someone else's push: §8.3 stands him 3 m off a hull after he has stepped
      let shoved = false;
      if (moved2 > STEP_MIN2) {
        for (let j = 0; j < L.UNITS; j += 4) {
          const tb = L.O_UNITS + j * L.U_WORDS;
          if (s[tb + L.U_STATE] === 0) continue;
          if (Math.hypot((s[b + L.U_X] - s[tb + L.U_X]) / Q, (s[b + L.U_Z] - s[tb + L.U_Z]) / Q) <= HULL_CLEAR) { shoved = true; break; }
        }
      }
      const stepped = moved2 > STEP_MIN2 && !shoved;
      if (moved2 > STEP_MIN2 && shoved) pushed++;

      const id = b4[2], onPlace = b4[3];               // what he held while the tick ran, not after it killed him
      const posture = stepped ? 'STAND' : onPlace ? 'COVER' : 'PRONE';

      manTicks++;
      if (posture === 'STAND') allStand++; else if (posture === 'COVER') allCover++; else allProne++;
      tickOf[posture]++;
      if (alive) {
        // the word the core WROTE this tick, against the posture the rule derives - they should agree once the
        // bits exist, and the share that disagrees is the tick of lag the rifle deliberately reads (see sim.js)
        const w = NAME[T.coverPosture(s, L.O_TACTICS, i)] || 'STAND';
        writtenSeen++;
        if (w === posture) writtenAgrees++;
      }
      if (b4[2] !== T.COVER_NONE) { heldTicks++; heldBy[posture]++; }

      // on the line, as §0 reads it: within 40 m of his own post
      const px = riflePost(s[squadWord(s[b + L.U_SIDE], s[b + L.U_TARGET])], i);
      const pz = add(frontAt(st, px) | 0, 0);
      const far = Math.hypot((b4[0] - px) / Q, (b4[1] - pz) / Q) * Q;
      if (far <= ON_LINE) {
        onLine++;
        if (moved2 > STEP_MIN2) standRaw++;
        if (!stepped) {
          didNotStep++;
          if (posture === 'COVER') cover++; else prone++;
          if (id === T.COVER_NONE) { openNotStepped++; if (posture === 'PRONE') openProne++; }
        } else stand++;
      }

      // the second fodder clause's baseline: a RIFLE death, by the posture he held at the tick he died
      if (alive) continue;
      if (nuked && Math.hypot(b4[0] / Q - nx, b4[1] / Q - nz) <= 40) continue;
      if (gone.some((g) => Math.hypot(b4[0] / Q - g.x, b4[1] / Q - g.z) <= 16)) continue;
      deaths[posture]++;
    }
  }
}
function add(a) { return a; }

const pc = (a, b) => `${((100 * a) / Math.max(b, 1)).toFixed(1)}%`;
console.log(`§11.4 POSTURE - derived here and compared against the word the core writes - ${SEEDS.length} seeds x ${TICKS / 60} s, a nuke every 30 s, tape ${SCROLL ? 'SCROLLING (a sample every 5 s)' : 'FROZEN (the §11.3 assert drive)'}`);
console.log(`\n  every living man-tick                ${manTicks}`);
console.log(`    STAND ${String(allStand).padStart(8)} (${pc(allStand, manTicks)})   PRONE ${String(allProne).padStart(8)} (${pc(allProne, manTicks)})   COVER ${String(allCover).padStart(8)} (${pc(allCover, manTicks)})`);
console.log(`\n  THIS LETTER'S "MEN HIDE" - of man-ticks where a man HOLDS a cover claim, is he written down as in it?`);
console.log(`    man-ticks holding a claim          ${heldTicks}`);
console.log(`      STAND (the fault)                ${heldBy.STAND}  (${pc(heldBy.STAND, heldTicks)})`);
console.log(`      PRONE                            ${heldBy.PRONE}  (${pc(heldBy.PRONE, heldTicks)})`);
console.log(`      COVER                            ${heldBy.COVER}  (${pc(heldBy.COVER, heldTicks)})`);
console.log(`      PRONE or COVER                   ${heldBy.PRONE + heldBy.COVER}  (${pc(heldBy.PRONE + heldBy.COVER, heldTicks)})`);
console.log(`    the WRITTEN word agrees with the derived posture on ${writtenAgrees} of ${writtenSeen} (${pc(writtenAgrees, writtenSeen)}) - the rest is the rifle's deliberate one-tick lag`);
console.log(`\n  §0 "MEN HIDE" - men ON THE LINE (within 40 m of post)`);
console.log(`    man-ticks on the line              ${onLine}`);
console.log(`    ...who did NOT step                ${didNotStep}  (${pc(didNotStep, onLine)})`);
console.log(`       of those PRONE                  ${prone}  (${pc(prone, didNotStep)})`);
console.log(`       of those COVER                  ${cover}  (${pc(cover, didNotStep)})`);
console.log(`       PRONE or COVER                  ${prone + cover}  (${pc(prone + cover, didNotStep)})   <- the row wants >= 85%`);
console.log(`    a man IN THE OPEN who did not step ${openNotStepped}, PRONE on ${openProne} (${pc(openProne, openNotStepped)})   <- the row wants 100%`);
console.log(`    (the "under fire" half of that clause needs §11.5's suppression word and cannot be read yet)`);
console.log(`\n  PUSHES COUNTED AS STEPS IF NOT CORRECTED: ${pushed} man-ticks moved only because §8.3 stood them off a hull`);
console.log(`    raw STAND on the line ${standRaw}, corrected ${stand} - the difference is ${standRaw - stand}`);
console.log(`\n  SECOND FODDER CLAUSE, TODAY'S BASELINE (rifle deaths per man-tick, by the posture held at death)`);
for (const k of ['STAND', 'PRONE', 'COVER'])
  console.log(`    ${k.padEnd(6)} deaths ${String(deaths[k]).padStart(5)}  man-ticks ${String(tickOf[k]).padStart(8)}  per 100k ticks ${((1e5 * deaths[k]) / Math.max(tickOf[k], 1)).toFixed(1)}`);
const dpS = deaths.STAND / Math.max(tickOf.STAND, 1);
const dpO = (deaths.PRONE + deaths.COVER) / Math.max(tickOf.PRONE + tickOf.COVER, 1);
console.log(`    STAND / (PRONE+COVER) rate ratio   ${(dpS / Math.max(dpO, 1e-12)).toFixed(2)}   <- the row wants >= 2.0, and a flat 4.5% rifle gives about 1`);
