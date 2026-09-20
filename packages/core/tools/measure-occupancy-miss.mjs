// WHAT THE §11.3 OCCUPANCY COUNTER ACTUALLY HOLDS ON THE TICKS IT FAILS (2026-09-20).
//
// The row is 64.6% against a 70% bar - 5.4 points under - and it was 72.9% before §11.5's crawl, so 8.3 points
// were lost. The story "pinned men crawl and cannot reach their holes" has been printed twice without being
// broken down, so this breaks it down rather than offering a third cause.
//
// WHAT THE COUNTER IS, read from tactics.test.js rather than assumed: a tick counts when ANY living man of a side
// is within 0.5 m of ANY place of his side. So a FAILING tick is one where not one man on the whole field is on a
// place. This classifies every living man on exactly those ticks.
//
// The classes are exclusive and are read from state, never guessed:
//   ON A PLACE        within 0.5 m of a place of his side (must be zero on a failing tick, and is the check)
//   CRAWLING IN       holds a claim, his team is PINNED, and he is not there yet
//   WALKING IN        holds a claim, team not pinned, not there yet
//   IN THE BOWL       holds a CRATER claim and stands inside that crater's radius, but over 0.5 m from the place
//   NO CLAIM          holds none at all
//
//   node packages/core/tools/measure-occupancy-miss.mjs [--long]
import { init, step, submitLiquidation } from '../src/sim.js';
import * as T from '../src/rules/tactics.js';
import * as C from '../src/rules/candles.js';
import * as L from '../src/state.js';

const Q = 65536;
const long = process.argv.includes('--long');
const SEEDS = long ? [1, 2, 3, 4, 5] : [1, 2];
const WARM = 900, TICKS = long ? 10800 : 2400;
const isMan = (i) => (i & L.ARMOUR_MASK) !== 0;
const WRECK_MAX = L.UNITS * 2, CRATER_MAX = WRECK_MAX + L.MAX_CRATERS * 4;

// the suite's own placesFor, kept independent so this is a check on the core and not a copy of it
const placesFor = (st, s, side) => {
  const out = [];
  for (let i = 0; i < L.UNITS; i++) {
    if (isMan(i)) continue;
    const b = L.O_UNITS + i * L.U_WORDS;
    if (s[b + L.U_STATE] !== 0 || s[b + L.U_HP] > 0) continue;
    out.push({ x: s[b] / Q - 2, z: s[b + 1] / Q + side * 3.6 }, { x: s[b] / Q + 2, z: s[b + 1] / Q + side * 3.6 });
  }
  for (let k = 0; k < L.MAX_CRATERS; k++) {
    const b = L.craterBase(k);
    if (s[b + L.C_R] <= 0 || s[b + L.C_ROUNDS] <= 0) continue;
    const cx = s[b + L.C_X] / Q, cz = s[b + L.C_Z] / Q, r = s[b + L.C_R] / Q - 1;
    for (const a of [-50, -20, 20, 50].map((d) => (d * Math.PI) / 180))
      out.push({ x: cx + r * Math.sin(a), z: cz + side * r * Math.cos(a) });
  }
  const shift = st.candleShift / Q, ramp = C.CANDLE_RAMP / Q + 0.5;
  for (let c = 0; c < C.CANDLES; c++) {
    const b = c * C.CL_WORDS;
    const z0 = st.candles[b + C.CL_Z0] / Q, z1 = st.candles[b + C.CL_Z1] / Q;
    if (z1 - z0 <= 0) continue;
    out.push({ x: st.candles[b + C.CL_X] / Q - shift, z: (side < 0 ? z0 : z1) - side * ramp });
  }
  return out;
};

let ticks = 0, hit = 0, miss = 0;
const cls = { onPlace: 0, crawlingIn: 0, walkingIn: 0, inTheBowl: 0, noClaim: 0 };
const leftToWalk = { crawlingIn: [], walkingIn: [] };
let missManTicks = 0;
// A MAN-TICK SHARE DOES NOT CONVERT INTO TICK-POINTS: a tick fails only when EVERY man is off his place, so a
// class can be a small share of the men and still be the only thing standing between a tick and a pass. What
// converts is this - of the failing ticks, how many hold at least one man of each class who could have been ON a
// place if that class's problem went away.
let missWithCrawler = 0, missWithWalker = 0, missWithNeither = 0;
const nearestOf = { crawl: [], walk: [] };

for (const seed of SEEDS) {
  const st = init(seed), s = st.i32;
  for (let t = 0; t < WARM; t++) step(st, Q, 0, 0, 0, 0);
  for (let t = 0; t < TICKS; t++) {
    if (t % 1800 === 300) submitLiquidation(st, 4000000);
    step(st, Q, 0, 0, 0, 0);
    ticks++;

    const pb = placesFor(st, s, -1), pr = placesFor(st, s, 1);
    const living = [];
    let on = false;
    for (let i = 0; i < L.UNITS; i++) {
      if (!isMan(i)) continue;
      const b = L.O_UNITS + i * L.U_WORDS;
      if (s[b + L.U_STATE] === 0 || s[b + L.U_HP] <= 0) continue;
      living.push(i);
      const mine = s[b + L.U_SIDE] < 0 ? pb : pr;
      if (mine.some((p) => Math.hypot(s[b] / Q - p.x, s[b + 1] / Q - p.z) <= 0.5)) on = true;
    }
    if (on) { hit++; continue; }
    miss++;

    // a failing tick: what is every living man doing?
    let anyCrawler = false, anyWalker = false, bestCrawl = Infinity, bestWalk = Infinity;
    for (const i of living) {
      const b = L.O_UNITS + i * L.U_WORDS;
      missManTicks++;
      const id = T.coverClaim(s, L.O_TACTICS, i);
      if (id === T.COVER_NONE) { cls.noClaim++; continue; }
      const side = s[b + L.U_SIDE] < 0 ? -1 : 1;
      const p = T.coverPlace(s, id, side, st.candles && !st.noCandleField ? st.candles : null, st.candleShift | 0);
      if (!p) { cls.noClaim++; continue; }
      const d = Math.hypot((s[b] - p.x) / Q, (s[b + 1] - p.z) / Q);
      if (d <= 0.5) { cls.onPlace++; continue; }          // must not happen on a failing tick
      // standing in the bowl he claimed, but not on the lip place
      if (id >= WRECK_MAX && id < CRATER_MAX) {
        const slot = Math.floor((id - WRECK_MAX) / 4), cb = L.craterBase(slot);
        if (s[cb + L.C_R] > 0 && s[cb + L.C_ROUNDS] > 0
            && Math.hypot((s[b] - s[cb + L.C_X]) / Q, (s[b + 1] - s[cb + L.C_Z]) / Q) < s[cb + L.C_R] / Q) {
          cls.inTheBowl++; continue;
        }
      }
      const rt = T.rifleTeamOf(i);
      if (T.isPinned(s, L.O_TACTICS, rt.side, rt.team)) {
        cls.crawlingIn++; leftToWalk.crawlingIn.push(d); anyCrawler = true; bestCrawl = Math.min(bestCrawl, d);
      } else {
        cls.walkingIn++; leftToWalk.walkingIn.push(d); anyWalker = true; bestWalk = Math.min(bestWalk, d);
      }
    }
    if (anyCrawler) { missWithCrawler++; nearestOf.crawl.push(bestCrawl); }
    if (anyWalker) { missWithWalker++; nearestOf.walk.push(bestWalk); }
    if (!anyCrawler && !anyWalker) missWithNeither++;
  }
}

const pc = (a, b) => `${((100 * a) / Math.max(b, 1)).toFixed(1)}%`;
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const occ = (100 * hit) / Math.max(ticks, 1);
console.log(`§11.3 OCCUPANCY, AND WHAT THE FAILING TICKS HOLD - ${SEEDS.length} seeds x ${TICKS / 60} s\n`);
console.log(`  ticks with a man on a place   ${hit} of ${ticks}  (${occ.toFixed(1)}%)   the bar is 70%`);
console.log(`  ticks with NOBODY on a place  ${miss}  (${pc(miss, ticks)})   ${(70 - occ).toFixed(1)} points under the bar\n`);
console.log(`  ON THOSE FAILING TICKS, every living man (${missManTicks} man-ticks):`);
for (const [k, label] of [['onPlace', 'on a place (must be nil)'], ['crawlingIn', 'CRAWLING in - claim held, team PINNED'],
                          ['walkingIn', 'walking in - claim held, not pinned'], ['inTheBowl', 'in the bowl he claimed, off the lip'],
                          ['noClaim', 'no claim at all']])
  console.log(`    ${label.padEnd(42)} ${String(cls[k]).padStart(8)}  (${pc(cls[k], missManTicks)})`);
console.log(`\n  still to walk, crawling  mean ${mean(leftToWalk.crawlingIn).toFixed(1)} m`);
console.log(`  still to walk, walking   mean ${mean(leftToWalk.walkingIn).toFixed(1)} m`);
console.log(`\n  THE SAME FAILING TICKS, COUNTED AS TICKS - this is what converts into points on the row:`);
console.log(`    hold at least one CRAWLER (pinned, claim held)   ${missWithCrawler} of ${miss}  (${pc(missWithCrawler, miss)})`);
console.log(`      nearest such crawler to his place, mean        ${mean(nearestOf.crawl).toFixed(1)} m`);
console.log(`    hold at least one WALKER (claim held, not pinned) ${missWithWalker} of ${miss}  (${pc(missWithWalker, miss)})`);
console.log(`      nearest such walker to his place, mean         ${mean(nearestOf.walk).toFixed(1)} m`);
console.log(`    hold NEITHER - nobody on the field even has a reachable claim  ${missWithNeither} of ${miss}  (${pc(missWithNeither, miss)})`);
const ptsCrawl = (100 * missWithCrawler) / Math.max(ticks, 1);
const ptsWalk = (100 * missWithWalker) / Math.max(ticks, 1);
console.log(`\n  AS POINTS ON THE ROW (out of the ${(70 - occ).toFixed(1)} under the bar, and the 8.3 lost from 72.9%):`);
console.log(`    ticks a crawler could have rescued   ${ptsCrawl.toFixed(1)} points`);
console.log(`    ticks a walker could have rescued    ${ptsWalk.toFixed(1)} points`);
console.log(`  Those overlap - a tick can hold both - so they are ceilings, not a partition.`);
