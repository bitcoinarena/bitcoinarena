// WHY THE §11.3 OCCUPANCY ROW MOVES, split three ways, on the §11.3 test's own drive (seeds 1 and 2, 900 ticks of
// warm-up, then 2400 with a nuke every 30 s) so the numbers sit beside the assertion they explain.
//
// the owner 2026-09-19, after §4.14's live trend took the row from 73.5% to 60.5%: "occupancy split by halted vs
// rushing, and by lip / wreck / crater. If the drop is halted men frozen off-cover because walk=0, that is still
// 11.3." It is not: the tool measures that first and the two groups reach their places at the same rate.
//
// The three tables:
//   1. claim man-ticks and the share REACHED (within §0's own 0.5 m), by kind and by halted / rushing
//   2. how far a man stands from his own LINE post (§9.2), holding a claim and not
//   3. how far he is from the place he claims, by the claim's age - whether he closes on it at all
//
//   node packages/core/tools/measure-cover-occupancy.mjs
import { init, step, submitLiquidation } from '../src/sim.js';
import { standingStill, riflePost } from '../src/rules/army.js';
import * as T from '../src/rules/tactics.js';
import * as L from '../src/state.js';

const Q = 65536, HALF_REST = 210;                      // sim.js's own, §11.2 half of a mean 7 s rest
const isMan = (i) => (i & L.ARMOUR_MASK) !== 0;
const WRECK_MAX = L.UNITS * 2, CRATER_MAX = WRECK_MAX + L.MAX_CRATERS * 4;
const kindOf = (id) => (id < WRECK_MAX ? 'wreck' : id < CRATER_MAX ? 'crater' : 'lip');
const KINDS = ['wreck', 'crater', 'lip'];
const SQUADS_PER_SIDE = (L.SQUAD_WORDS / 2) | 0;
const squadWord = (side, k) => L.O_SQUADS + (side < 0 ? k : SQUADS_PER_SIDE + k);
const AGES = [0, 1, 2, 4, 6, 8, 10, 14];

const held = {}, on = {};
for (const k of KINDS) for (const g of ['halted', 'rushing']) { held[k + g] = 0; on[k + g] = 0; }
const fromPost = { claim: [], none: [] };
const byAge = new Map(AGES.map((a) => [a, [0, 0]]));
let ticks = 0, tickOn = 0;

for (const seed of [1, 2]) {
  const st = init(seed), s = st.i32;
  for (let t = 0; t < 900; t++) step(st, Q, 0, 0, 0, 0);
  const openAt = new Map(), openId = new Map();
  for (let t = 0; t < 2400; t++) {
    if (t % 1800 === 300) submitLiquidation(st, 4000000);
    step(st, Q, 0, 0, 0, 0);
    ticks++;
    // the fire team clocks of the tick that just ran, as sim.js builds them (it bumps O_TICK before the infantry step)
    const halt = [[], []];
    for (let sd = 0; sd < 2; sd++)
      for (let f = 0; f < T.FIRE_TEAMS_PER_SIDE; f++) {
        const key = T.mix(s[L.O_TACTICS + T.TAC_SEED], 500 + Math.imul(sd, 16) + f) & 0x7fffffff;
        const raw = standingStill(key, (s[L.O_TICK] - ((f & 1) === 1 ? HALF_REST : 0)) | 0);
        halt[sd][f] = raw && !(f > 0 && halt[sd][f - 1]);
      }
    let any = false;
    for (let i = 0; i < L.UNITS; i++) {
      if (!isMan(i)) continue;
      const b = L.O_UNITS + i * L.U_WORDS;
      if (s[b + L.U_STATE] === 0 || s[b + L.U_HP] <= 0) { openAt.delete(i); openId.delete(i); continue; }
      const id = T.coverClaim(s, L.O_TACTICS, i);
      const rt = T.rifleTeamOf(i);
      if (t % 10 === 0) {
        const first = T.firstManOf(rt.side, rt.team);
        const anchor = s[squadWord(rt.side, s[L.O_UNITS + first * L.U_WORDS + L.U_TARGET])];
        fromPost[id === T.COVER_NONE ? 'none' : 'claim'].push(Math.abs(s[b] - riflePost(anchor, i)) / Q);
      }
      if (id === T.COVER_NONE) { openAt.delete(i); openId.delete(i); continue; }
      if (openId.get(i) !== id) { openAt.set(i, t); openId.set(i, id); }
      const p = T.coverPlace(s, id, s[b + L.U_SIDE] < 0 ? -1 : 1, st.candles, st.candleShift | 0);
      if (!p) continue;
      const g = halt[rt.side < 0 ? 0 : 1][rt.team] ? 'halted' : 'rushing';
      const k = kindOf(id), d = Math.hypot((s[b] - p.x) / Q, (s[b + 1] - p.z) / Q);
      held[k + g]++;
      if (d <= 0.5) { on[k + g]++; any = true; }
      const age = (t - openAt.get(i)) / 60;
      for (const a of AGES) if (age >= a && age < a + 1) { const e = byAge.get(a); e[0] += d; e[1]++; }
    }
    if (any) tickOn++;
  }
}

const pc = (a, b) => `${((100 * a) / Math.max(b, 1)).toFixed(1)}%`;
console.log(`OCCUPANCY (the §11.3 test's metric): ${tickOn} of ${ticks} ticks  (${pc(tickOn, ticks)})   the row's bar is 70%`);
console.log('\n1. CLAIMS REACHED, by kind and by the fire team\'s clock');
console.log('   kind      man-ticks HALTED    reached        man-ticks RUSHING    reached');
let H = 0, HO = 0, R = 0, RO = 0;
for (const k of KINDS) {
  const hh = held[k + 'halted'], ho = on[k + 'halted'], rh = held[k + 'rushing'], ro = on[k + 'rushing'];
  H += hh; HO += ho; R += rh; RO += ro;
  console.log(`   ${k.padEnd(8)}${String(hh).padStart(17)}${String(ho).padStart(11)} (${pc(ho, hh)})${String(rh).padStart(17)}${String(ro).padStart(11)} (${pc(ro, rh)})`);
}
console.log(`   ${'ALL'.padEnd(8)}${String(H).padStart(17)}${String(HO).padStart(11)} (${pc(HO, H)})${String(R).padStart(17)}${String(RO).padStart(11)} (${pc(RO, R)})`);
console.log('   A halted man cannot step (army.js walk = 0), so a halted claim-holder is one who already arrived or');
console.log('   one frozen short. The two rates being equal is what says the halt clock is not what keeps men out.');

const stat = (a) => { const b = a.slice().sort((x, y) => x - y);
  return `mean ${(b.reduce((x, y) => x + y, 0) / b.length).toFixed(1)} m, median ${b[b.length >> 1].toFixed(1)}, p90 ${b[Math.floor(b.length * 0.9)].toFixed(1)}`; };
console.log('\n2. HOW FAR A MAN STANDS FROM HIS OWN LINE POST (§9.2)');
console.log(`   holding a claim   ${stat(fromPost.claim)}`);
console.log(`   no claim          ${stat(fromPost.none)}`);
console.log('   §11.3 measures eligibility from the POST, so a man who has walked away from his post to a hole is');
console.log('   offered his next hole near a post he no longer stands on.');

console.log('\n3. HOW FAR HE IS FROM THE PLACE HE CLAIMS, by the claim\'s age');
console.log('   age s   mean distance   man-ticks');
for (const a of AGES) { const [d, n] = byAge.get(a); if (n) console.log(`   ${String(a).padStart(5)}   ${(d / n).toFixed(2).padStart(13)}   ${n}`); }
console.log('   He closes, and slowly: a claim does not live long enough for his own gait to cross what he is given.');
