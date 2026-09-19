// HOW MUCH ROOM COVER HAS - the X side of WAR_TACTICS.md §0's "wrecks and craters are used" row (§11.3),
// measured on the tree that is deployed today, and the answer to the owner's own question: how many of today's
// deaths happen where a place would have existed.
//
// §11.3 is a declared GAP - no TAC_COVER word, no places, no claims - so "is anyone on a place" is expected to be
// nil. The numbers that decide what this letter is worth are the other two:
//
//   1. of the men killed BY FIRE, the share that had a free place within 12 m when they died
//   2. of all ticks, the share on which a place existed at all within 12 m of a living man
//
// The places are the spec's own (§11.3), computed here because the core has none:
//   a wreck (a dead armour index, its hull words keeping the place it died) has 2:
//       (wreck x +- 2 m, wreck z + side x 3.6 m)
//   a crater has 4, on the near lip 1 m inside it:
//       centre + (R - 1 m) x (sin a, side x cos a), a = -50, -20, +20, +50 degrees from the seam normal
//
// TWO THINGS MAKE THIS A FLOOR, and both are stated rather than hidden. A CANDLE LIP IS NOT COUNTED: §11.3 gives
// one place every 4 m along a plateau edge standing between a man's post and the enemy, and that geometry scrolls
// with the chart. And the 12 m is measured from where the man IS, not from his post: §11.3 measures from the post
// "so a man does not wander to cover", and reconstructing every rifleman's post needs his squad anchor and his own
// scatter. A man is near his post, so the two differ by metres, and both simplifications can only make the
// denominator LARGER than the spec's - so a small number here is a real ceiling on what cover can do.
//
//   node packages/core/tools/measure-cover-baseline.mjs
import { init, step, submitLiquidation } from '../src/sim.js';
import { riflePost, RIFLE_STANDOFF } from '../src/rules/army.js';
import { coverClaim, COVER_NONE } from '../src/rules/tactics.js';
import * as C from '../src/rules/candles.js';
import * as L from '../src/state.js';

const ONE = 65536, Q = ONE;
const SEEDS = [1, 2, 3];
const SECONDS = 120;
const REACH = 12;                        // §11.3's eligibility, metres from the man
const isMan = (i) => (i & L.ARMOUR_MASK) !== 0;
const ANG = [-50, -20, 20, 50].map((d) => (d * Math.PI) / 180);

const placesFor = (s, side, st) => {
  const out = [];
  // §11.3's third kind, added to this tool when the core got them: one place along each body's near edge, at the
  // foot of the ramp on the man's side and half a metre out, scrolling with the chart.
  if (st && st.candles && !st.noCandleField) {
    const shift = st.candleShift / Q, ramp = C.CANDLE_RAMP / Q + 0.5;
    for (let c = 0; c < C.CANDLES; c++) {
      const b = c * C.CL_WORDS;
      const z0 = st.candles[b + C.CL_Z0] / Q, z1 = st.candles[b + C.CL_Z1] / Q;
      if (z1 - z0 <= 0) continue;
      out.push({ x: st.candles[b + C.CL_X] / Q - shift, z: (side < 0 ? z0 : z1) - side * ramp });
    }
  }
  for (let i = 0; i < L.UNITS; i++) {                       // wrecks
    if (isMan(i)) continue;
    const b = L.O_UNITS + i * L.U_WORDS;
    if (s[b + L.U_STATE] !== 0 || s[b + L.U_HP] > 0) continue;
    const x = s[b + L.U_X] / Q, z = s[b + L.U_Z] / Q;
    out.push({ x: x - 2, z: z + side * 3.6 }, { x: x + 2, z: z + side * 3.6 });
  }
  for (let k = 0; k < L.MAX_CRATERS; k++) {                 // craters
    const b = L.craterBase(k);
    if (s[b + L.C_R] <= 0 || s[b + L.C_ROUNDS] <= 0) continue;
    const cx = s[b + L.C_X] / Q, cz = s[b + L.C_Z] / Q, r = s[b + L.C_R] / Q - 1;
    for (const a of ANG) out.push({ x: cx + r * Math.sin(a), z: cz + side * r * Math.cos(a) });
  }
  return out;
};

let fireDeaths = 0, fireWithPlace = 0, ticks = 0, ticksWithPlace = 0, ticksOnPlace = 0, placeTicks = 0, ticksWithPlaceAtPost = 0, claimTicks = 0, manTicks = 0;
for (const seed of SEEDS) {
  const st = init(seed), s = st.i32;
  for (let t = 0; t < 900; t++) step(st, Q, 0, 0, 0, 0);
  let strike = s[L.O_STRIKE + L.K_SERIAL];
  let bombsBefore = [];
  for (let t = 0; t < SECONDS * 60; t++) {
    if (t % 1800 === 300) submitLiquidation(st, 4000000);   // craters are cover: one nuke every 30 s
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
      if (s[bb + L.B_STATE] !== 0) bombs.push({ k, x: s[bb + L.B_X] / Q, z: s[bb + L.B_Z] / Q });
    }
    const placeBull = placesFor(s, -1, st), placeBear = placesFor(s, 1, st);

    // the row's own question, on the state as it stands this tick. TWO READINGS, because they answer different
    // things: from where the man STANDS (how much cover is around the fighting) and from his POST, which is what
    // §11.3 actually measures eligibility by - "his post, not his position, so a man does not wander to cover".
    ticks++;
    let near = false, on = false, nearPost = false;
    for (const m of before) {
      const mine = m.side < 0 ? placeBull : placeBear;
      const px = riflePost(s[L.O_SQUADS + (m.side < 0 ? s[L.O_UNITS + m.i * L.U_WORDS + L.U_TARGET] : L.SQUADS_PER_SIDE + s[L.O_UNITS + m.i * L.U_WORDS + L.U_TARGET])], m.i) / Q;
      const pz = m.z;                                   // the line he holds; his own scatter is metres, not tens
      for (const p of mine) {
        const d = Math.hypot(m.x - p.x, m.z - p.z);
        if (d <= REACH) near = true;
        if (d <= 0.5) on = true;
        if (Math.hypot(px - p.x, pz - p.z) <= REACH) nearPost = true;
      }
    }
    if (near) ticksWithPlace++;
    if (nearPost) ticksWithPlaceAtPost++;
    if (on) ticksOnPlace++;
    placeTicks += placeBull.length + placeBear.length;

    step(st, Q, 0, 0, 0, 0);

    const nuked = s[L.O_STRIKE + L.K_SERIAL] !== strike;
    if (nuked) strike = s[L.O_STRIKE + L.K_SERIAL];
    const nx = s[L.O_STRIKE + L.K_X] / Q, nz = s[L.O_STRIKE + L.K_Z] / Q;
    const gone = bombsBefore.filter((k) => s[L.O_BOMBS + k.k * L.B_WORDS + L.B_STATE] === 0);
    bombsBefore = bombs;

    for (const m of before) {
      manTicks++;
      if (coverClaim(s, L.O_TACTICS, m.i) !== COVER_NONE) claimTicks++;
      const b = L.O_UNITS + m.i * L.U_WORDS;
      if (s[b + L.U_HP] > 0 && s[b + L.U_STATE] !== 0) continue;         // alive, or a slot refilled: not a death
      if (nuked && Math.hypot(m.x - nx, m.z - nz) <= 40) continue;        // nuke: cover is no answer to it
      if (gone.some((g) => Math.hypot(m.x - g.x, m.z - g.z) <= 16)) continue;   // bomb: clears its circle
      fireDeaths++;
      const mine = m.side < 0 ? placeBull : placeBear;
      if (mine.some((p) => Math.hypot(m.x - p.x, m.z - p.z) <= REACH)) fireWithPlace++;
    }
  }
}

const pc = (a, b) => `${((100 * a) / Math.max(b, 1)).toFixed(1)}%`;
console.log(`COVER'S ROOM TODAY, ${SEEDS.length} seeds x ${SECONDS} s, a nuke every 30 s`);
console.log(`  men killed by fire                         ${fireDeaths}`);
console.log(`  ...with a free place within ${REACH} m of them    ${fireWithPlace}  (${pc(fireWithPlace, fireDeaths)})`);
console.log(`  ticks with a place within ${REACH} m of a man      ${ticksWithPlace} of ${ticks}  (${pc(ticksWithPlace, ticks)})`);
console.log(`  ticks with a man ON a place (within 0.5 m) ${ticksOnPlace} of ${ticks}  (${pc(ticksOnPlace, ticks)})`);
console.log(`  places standing, mean per tick             ${(placeTicks / Math.max(ticks, 1)).toFixed(1)}`);
console.log(`  ticks with a place within ${REACH} m of a POST     ${ticksWithPlaceAtPost} of ${ticks}  (${pc(ticksWithPlaceAtPost, ticks)})   <- the row's own denominator`);
console.log(`  man-ticks holding a claim                  ${claimTicks} of ${manTicks}  (${pc(claimTicks, manTicks)})`);
console.log(`\n  §0's row wants a man on a place on >= 70% of the ticks where one is free within 12 m of a post.`);
console.log(`  The core has no places and no claims, so the "on a place" number is what the GAP looks like.`);
