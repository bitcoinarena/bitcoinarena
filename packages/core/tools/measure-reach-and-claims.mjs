// WHY THE MEN OFF THEIR HOLES ARE OFF THEM (2026-09-20). Two prints, no hypothesis.
//
// The share is already printed and is not re-litigated here: of the 1698 failing ticks, 100% hold an UNPINNED man
// with a claim about 8.9 m from his hole and 68.1% also hold a crawler 18.2 m out, so freezing every crawler
// clears none of those ticks. Crawl is a ceiling of 24.1 points. That is the whole remaining miss.
//
// PRINT 1 - PER-MAN 12 m REACH, on failing ticks. §11.3 measures eligibility from the POST, so a man whose post
// has no place inside 12 m can never be in cover however well he walks. For every man on a failing tick: is there
// a place within 12 m of his post at all, is the nearest one free or already claimed by someone else, and could
// he cross what is left this tick at his own gait.
//
// PRINT 2 - A CLAIM FROM TAKE TO END. Per man over the whole run: how many claims he took, how many he ever
// ARRIVED at (within 0.5 m), how many were overwritten under him while he still held one, and how long he spent
// holding nothing at all. A man who takes claims and never once arrives is a different fault from a man who
// arrives and is moved on.
//
//   node packages/core/tools/measure-reach-and-claims.mjs [--long]
import { init, step, submitLiquidation, frontAt } from '../src/sim.js';
import { riflePost, RIFLE_STANDOFF } from '../src/rules/army.js';
import * as T from '../src/rules/tactics.js';
import * as C from '../src/rules/candles.js';
import * as L from '../src/state.js';

const Q = 65536;
const long = process.argv.includes('--long');
const SEEDS = long ? [1, 2, 3, 4, 5] : [1, 2];
const WARM = 900, TICKS = long ? 10800 : 2400;
const REACH = 12;                                    // §11.3's eligibility from the post
const GAIT = 182714 / Q / 60;                        // RIFLE_WALK, metres a tick
const isMan = (i) => (i & L.ARMOUR_MASK) !== 0;
const SQUADS_PER_SIDE = (L.SQUAD_WORDS / 2) | 0;
const squadWord = (side, k) => L.O_SQUADS + (side < 0 ? k : SQUADS_PER_SIDE + k);

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

let failTicks = 0;
const reach = { noPlaceNearPost: 0, placeFreeNearPost: 0, placeTakenNearPost: 0, men: 0, reachableThisTick: 0 };
// WHY A MAN WITH A PLACE IN REACH OF HIS POST STILL HOLDS NOTHING. §11.3's eligibility is three tests, not one:
// within reach of the POST, inside his clamp [seam - side x 40, seam + side x 8], and not inside 3 m of a living
// tank. This splits the refusal so the cause is named rather than guessed at.
const why = { clamp: 0, tank: 0, eligibleButUnclaimed: 0 };
const nearestToPost = [];
// per man, over the whole run
const took = new Map(), arrived = new Map(), overwritten = new Map(), heldTicks = new Map(), aliveTicks = new Map();
const open = new Map();

for (const seed of SEEDS) {
  const st = init(seed), s = st.i32;
  for (let t = 0; t < WARM; t++) step(st, Q, 0, 0, 0, 0);
  for (let t = 0; t < TICKS; t++) {
    if (t % 1800 === 300) submitLiquidation(st, 4000000);
    step(st, Q, 0, 0, 0, 0);

    const pb = placesFor(st, s, -1), pr = placesFor(st, s, 1);
    const living = [];
    let on = false;
    const claimed = new Set();
    for (let i = 0; i < L.UNITS; i++) {
      if (!isMan(i)) continue;
      const b = L.O_UNITS + i * L.U_WORDS;
      if (s[b + L.U_STATE] === 0 || s[b + L.U_HP] <= 0) continue;
      living.push(i);
      const key = `${seed}:${i}`;
      aliveTicks.set(key, (aliveTicks.get(key) || 0) + 1);
      const id = T.coverClaim(s, L.O_TACTICS, i);
      if (id !== T.COVER_NONE) {
        claimed.add(id);
        heldTicks.set(key, (heldTicks.get(key) || 0) + 1);
        const prev = open.get(key);
        if (prev === undefined) { open.set(key, id); took.set(key, (took.get(key) || 0) + 1); }
        else if (prev !== id) { open.set(key, id); took.set(key, (took.get(key) || 0) + 1); overwritten.set(key, (overwritten.get(key) || 0) + 1); }
        const p = T.coverPlace(s, id, s[b + L.U_SIDE] < 0 ? -1 : 1, st.candles, st.candleShift | 0);
        if (p && Math.hypot((s[b] - p.x) / Q, (s[b + 1] - p.z) / Q) <= 0.5) arrived.set(key, (arrived.get(key) || 0) + 1);
      } else open.delete(key);
      const mine = s[b + L.U_SIDE] < 0 ? pb : pr;
      if (mine.some((p) => Math.hypot(s[b] / Q - p.x, s[b + 1] / Q - p.z) <= 0.5)) on = true;
    }
    if (on) continue;
    failTicks++;

    // PRINT 1: every man on a failing tick, measured from his POST as §11.3 does
    for (const i of living) {
      const b = L.O_UNITS + i * L.U_WORDS;
      const rt = T.rifleTeamOf(i);
      if (T.isPinned(s, L.O_TACTICS, rt.side, rt.team)) continue;      // unpinned walkers only, as asked
      reach.men++;
      const side = s[b + L.U_SIDE] < 0 ? -1 : 1;
      const px = riflePost(s[squadWord(s[b + L.U_SIDE], s[b + L.U_TARGET])], i);
      const pz = (frontAt(st, px) | 0) + Math.imul(side, RIFLE_STANDOFF);
      const mine = side < 0 ? pb : pr;
      let best = Infinity;
      for (const p of mine) best = Math.min(best, Math.hypot(px / Q - p.x, pz / Q - p.z));
      nearestToPost.push(best);
      if (best > REACH) { reach.noPlaceNearPost++; continue; }
      // a place IS in reach of his post: is the one he holds free, and can he cross to it this tick?
      const id = T.coverClaim(s, L.O_TACTICS, i);
      if (id === T.COVER_NONE) {
        reach.placeTakenNearPost++;
        // walk his own side's places in order of distance from his post and ask WHY the nearest ones are refused
        const seam = frontAt(st, px) | 0;
        const sorted = mine.map((p) => ({ p, d: Math.hypot(px / Q - p.x, pz / Q - p.z) }))
                           .filter((e) => e.d <= REACH).sort((a, b2) => a.d - b2.d);
        let named = false;
        for (const e of sorted) {
          const place = { x: Math.round(e.p.x * Q), z: Math.round(e.p.z * Q) };
          const depth = ((place.z - seam) / Q) * side;
          if (depth > 8 || depth < -40) { if (!named) { why.clamp++; named = true; } continue; }
          let nearTank = false;
          for (let j = 0; j < L.UNITS && !nearTank; j += 4) {
            const tb = L.O_UNITS + j * L.U_WORDS;
            if (s[tb + L.U_STATE] === 0) continue;
            if (Math.hypot((place.x - s[tb]) / Q, (place.z - s[tb + 1]) / Q) < 3) nearTank = true;
          }
          if (nearTank) { if (!named) { why.tank++; named = true; } continue; }
          if (!named) { why.eligibleButUnclaimed++; named = true; }
          break;
        }
      } else reach.placeFreeNearPost++;
      if (id !== T.COVER_NONE) {
        const p = T.coverPlace(s, id, side, st.candles, st.candleShift | 0);
        if (p && Math.hypot((s[b] - p.x) / Q, (s[b + 1] - p.z) / Q) <= GAIT) reach.reachableThisTick++;
      }
    }
  }
}

const pc = (a, b) => `${((100 * a) / Math.max(b, 1)).toFixed(1)}%`;
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const med = (a) => { const b = a.slice().sort((x, y) => x - y); return b.length ? b[b.length >> 1] : 0; };

console.log(`PRINT 1 - THE 12 m REACH FROM HIS POST, unpinned men on failing ticks (${failTicks} failing ticks)\n`);
console.log(`  unpinned man-ticks on failing ticks        ${reach.men}`);
console.log(`    NO place within 12 m of his post         ${reach.noPlaceNearPost}  (${pc(reach.noPlaceNearPost, reach.men)})`);
console.log(`    a place in reach, and he HOLDS a claim   ${reach.placeFreeNearPost}  (${pc(reach.placeFreeNearPost, reach.men)})`);
console.log(`    a place in reach, he holds NOTHING       ${reach.placeTakenNearPost}  (${pc(reach.placeTakenNearPost, reach.men)})`);
console.log(`    ...of the claim-holders, could cross it this tick ${reach.reachableThisTick}`);
console.log(`  nearest place to his POST   mean ${mean(nearestToPost).toFixed(1)} m, median ${med(nearestToPost).toFixed(1)} m`);
console.log(`\n  OF THE MEN HOLDING NOTHING WITH A PLACE IN REACH, why the nearest in-reach place is refused:`);
console.log(`    outside his clamp [seam - 40, seam + 8]   ${why.clamp}  (${pc(why.clamp, reach.placeTakenNearPost)})`);
console.log(`    inside 3 m of a living tank              ${why.tank}  (${pc(why.tank, reach.placeTakenNearPost)})`);
console.log(`    ELIGIBLE and still not claimed           ${why.eligibleButUnclaimed}  (${pc(why.eligibleButUnclaimed, reach.placeTakenNearPost)})`);

const keys = [...aliveTicks.keys()];
const never = keys.filter((k) => !arrived.has(k));
const tookAny = keys.filter((k) => took.has(k));
const neverTook = keys.filter((k) => !took.has(k));
console.log(`\nPRINT 2 - A CLAIM FROM TAKE TO END, every man over the run (${keys.length} men)\n`);
console.log(`  men who never held a claim at all          ${neverTook.length}  (${pc(neverTook.length, keys.length)})`);
console.log(`  men who took at least one                  ${tookAny.length}  (${pc(tookAny.length, keys.length)})`);
console.log(`  men who NEVER once arrived on a hole       ${never.length}  (${pc(never.length, keys.length)})`);
console.log(`  claims taken, per man that took any        mean ${mean(tookAny.map((k) => took.get(k))).toFixed(1)}`);
console.log(`  of those, overwritten under him            mean ${mean(tookAny.map((k) => overwritten.get(k) || 0)).toFixed(1)}`);
console.log(`  share of a man's living ticks holding one  ${pc(keys.reduce((a, k) => a + (heldTicks.get(k) || 0), 0), keys.reduce((a, k) => a + aliveTicks.get(k), 0))}`);
console.log(`  share of a man's living ticks ON a hole    ${pc(keys.reduce((a, k) => a + (arrived.get(k) || 0), 0), keys.reduce((a, k) => a + aliveTicks.get(k), 0))}`);
