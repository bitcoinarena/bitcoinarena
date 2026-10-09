// Tank doctrine, before and after - read from the STATE only, so the same numbers come out of any core.
//
//     node tools/measure-doctrine.mjs [--core=DIR/src] [--seeds=1,2,3,4,5] [--ticks=3600]
//
// measure-war.mjs patches hooks into the core it measures and needs rules/tactics.js; a core from before the
// doctrine has neither. This one reads positions, the tape and the ground, so a committed core and the working
// tree are measured by one ruler (WAR_TACTICS.md §0, §2-§4):
//   camping   a standing tank (moved < 0.02 m) within 8 m of the seam at its own x, or across it
//   wiggle    reversals of a tank's z travel (moves > 0.02 m), and those inside 2 s of the one before
//   bound     a pair (roster k, k^1) both standing: their depth offset; runs of z travel between stops
//   hull-down a standing tank's ground rise 6 m toward the enemy (the crest in front of the hull)
//   bubble    tank pairs inside 11.5 m (the 12 m rule, one tick of travel allowed)
//   truck     tank positions with the truck parked vs teleported along the seam, until the worlds differ
// Truck in its bay, handbrake on, except the truck row.
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const SRC = arg('core', new URL('../src', import.meta.url).pathname);
const SEEDS = arg('seeds', '1,2,3,4,5').split(',').map(Number);
const TICKS = Number(arg('ticks', 3600));
const url = (rel) => pathToFileURL(join(SRC, rel)).href;
const { init, step, teleport, groundAt } = await import(url('sim.js'));
const L = await import(url('state.js'));
const { frontlineZ } = await import(url('rules/frontline.js'));
const T = existsSync(join(SRC, 'rules/tactics.js')) ? await import(url('rules/tactics.js')) : null;

const ONE = 65536, HX = 130 * ONE, HZ = 85 * ONE;
const ARMOUR = Array.from({ length: 24 }, (_, k) => k * 4);
const base = (i) => L.O_UNITS + i * L.U_WORDS;
const sideOf = (i) => (((i >> 2) & 1) === 0 ? -1 : 1);
const partner = (i) => ((((i >> 3) & 15) ^ 1) << 3) | (i & 4);
const r = {}; const add = (k, n = 1) => { r[k] = (r[k] || 0) + n; };
const runs = [], pairGaps = [], postGaps = [], avail = { n: 0, best: 0, took: 0, atBest: 0 };
const spans = [], nearest = [], scoots = { toward: 0, away: 0, sum: 0, n: 0, mToward: 0, mAway: 0 }; let closest = Infinity;

for (const seed of SEEDS) {
  const st = init(seed), s = st.i32;
  const lastSign = new Map(), lastRev = new Map(), run = new Map(), still = new Map(); const slotWas = [];
  for (let t = 0; t < TICKS; t++) {
    const pre = ARMOUR.map((i) => [s[base(i)], s[base(i) + 1], s[base(i) + L.U_STATE]]);
    step(st, 0, 0, 0, ONE, 0);
    const tick = s[L.O_TICK];
    const standing = new Map();
    ARMOUR.forEach((i, k) => {
      if (s[base(i) + L.U_STATE] === 0 || pre[k][2] === 0) { run.delete(i); return; }
      const dx = (s[base(i)] - pre[k][0]) / ONE, dz = (s[base(i) + 1] - pre[k][1]) / ONE, mv = Math.hypot(dx, dz);
      if (mv > 5) { run.delete(i); lastSign.delete(i); return; }                 // a respawn, not a move
      const sd = sideOf(i), x = s[base(i)], z = s[base(i) + 1];
      const behind = (z - frontlineZ(st.tape, x, HX, HZ)) * sd / ONE;             // + = own side of the seam
      add('tank-ticks');
      if (mv < 0.02) {
        standing.set(i, behind);
        add('standing');
        if (behind < 8) add('camping');
        if (behind < 0) add('standing across');
        add('standing behind sum', behind);
        const rise = (groundAt(st, x, z - sd * 6 * ONE) - groundAt(st, x, z)) / ONE;
        add('rise sum', rise); if (rise >= 0.3) add('hull-down');
        if (T) { const role = T.isBounding(s, L.O_TACTICS, i, tick) ? 'bounding' : 'overwatch';
          add(`${role} standing`); add(`${role} rise sum`, rise); if (rise >= 0.3) add(`${role} hull-down`); }
        // a BOUND ends at a stop of at least 0.5 s: a tick held by the half-line budget is a pause, not the end of it
        still.set(i, (still.get(i) || 0) + 1);
        if (still.get(i) === 30) { const ru = run.get(i); if (ru && Math.abs(ru) > 1) runs.push(Math.abs(ru)); run.delete(i); }
        if (T) {
          const p = T.postOf(s, L.O_TACTICS, i, tick);
          if (behind < 8) add(p.depth / ONE < 8 ? 'camping on a pushed post' : 'camping off its post');
          if (!p.bounding) {
            // what the hull-down search had to choose from at this hold line: five candidates, -4..+4 m
            const seamP = frontlineZ(st.tape, p.x, HX, HZ), hold = seamP + sd * p.depth;
            let best = -1e9, at0 = 0;
            for (let c = -2; c <= 2; c++) { const zc = hold + c * 2 * ONE; const rc = (groundAt(st, p.x, zc - sd * 6 * ONE) - groundAt(st, p.x, zc)) / ONE; if (rc > best) best = rc; if (c === 0) at0 = rc; }
            avail.n++; if (best >= 0.3) avail.best++; if (at0 >= 0.3) avail.took++; if (rise >= best - 0.05) avail.atBest++;
          }
        }
      } else {
        still.set(i, 0);
        run.set(i, (run.get(i) || 0) + dz);
        if (Math.abs(dz) > 0.02) {
          const sg = Math.sign(dz), was = lastSign.get(i);
          if (was && was !== sg) { add('reversals'); const lr = lastRev.get(i); if (lr !== undefined && tick - lr < 120) add('fidgets'); lastRev.set(i, tick); }
          lastSign.set(i, sg);
        }
      }
    });
    for (const [i, b] of standing) { const j = partner(i); if (j > i && standing.has(j)) { pairGaps.push(Math.abs(b - standing.get(j)));
      if (T) postGaps.push(Math.abs(T.postOf(s, L.O_TACTICS, i, tick).depth - T.postOf(s, L.O_TACTICS, j, tick).depth) / ONE); } }
    const live = ARMOUR.filter((i) => s[base(i) + L.U_STATE] !== 0);
    // FRONTAGE: the x span a side's living tanks cover; spacing to the nearest tank of the same side; same metre
    for (const sd of [-1, 1]) {
      const ls = live.filter((i) => sideOf(i) === sd);
      if (ls.length >= 6) { const xs = ls.map((i) => s[base(i)] / ONE); spans.push(Math.max(...xs) - Math.min(...xs)); }
      for (const i of ls) {
        let d = Infinity;
        for (const j of ls) if (j !== i) d = Math.min(d, Math.hypot(s[base(i)] - s[base(j)], s[base(i) + 1] - s[base(j) + 1]) / ONE);
        if (d < Infinity) { nearest.push(d); if (d < 1) add('same metre'); add('same-metre samples'); }
        if (T) { add('role ' + (T.isBounding(s, L.O_TACTICS, i, tick) ? 'bounding' : 'overwatch')); }
      }
      if (T) for (const i of ls) { const j = T.partnerOf(i); if (j > i && s[base(j) + L.U_STATE]) {
        add('pair-both-alive'); if (T.isBounding(s, L.O_TACTICS, i, tick) !== T.isBounding(s, L.O_TACTICS, j, tick)) add('pair one of each');
        if (T.postOf(s, L.O_TACTICS, i, tick).x === T.postOf(s, L.O_TACTICS, j, tick).x) add('pair same post x'); } }
    }
    for (const i of live) for (const j of live) if (i < j) closest = Math.min(closest, Math.hypot(s[base(i)] - s[base(j)], s[base(i) + 1] - s[base(j) + 1]) / ONE);
    // SHOOT-AND-SCOOT against the truck: every slot change, did it take the team nearer the truck or further away?
    if (T) for (let w = 0; w < 12; w++) {
      const now = s[L.O_TACTICS + T.TAC_SLOT + w];
      if (slotWas[w] !== undefined && now !== slotWas[w]) {
        const tx = s[L.O_TRUCK + L.T_X];
        const delta = (Math.abs(T.slotX(now) - tx) - Math.abs(T.slotX(slotWas[w]) - tx)) / ONE;
        scoots.n++; scoots.sum += delta; if (delta < 0) scoots.toward++; else scoots.away++;
        // the same slot change against the bay at the other end of the map (x mirrored): posts do not read the truck
        const mirror = (Math.abs(T.slotX(now) + tx) - Math.abs(T.slotX(slotWas[w]) + tx)) / ONE;
        if (mirror < 0) scoots.mToward++; else scoots.mAway++;
      }
      slotWas[w] = now;
    }
    for (let p = 0; p < live.length; p++) for (let q = p + 1; q < live.length; q++) {
      add('pair-ticks'); if (Math.hypot(s[base(live[p])] - s[base(live[q])], s[base(live[p]) + 1] - s[base(live[q]) + 1]) < 11.5 * ONE) add('inside 11.5');
    }
  }
}

// The truck: parked in the bay against driven along the seam through the whole line, same seed, practice on so a
// touch does not end the run. Compared tick by tick until the worlds differ (a shot at the truck draws).
let tc = 0, td = 0, split = [];
for (const seed of SEEDS) {
  const a = init(seed), b = init(seed); let t = 0;
  for (; t < TICKS; t++) {
    step(a, 0, 0, 0, ONE, ONE);
    teleport(b, Math.round((-80 + 160 * t / TICKS) * ONE), Math.round(frontlineZ(b.tape, Math.round((-80 + 160 * t / TICKS) * ONE), HX, HZ)), 16384);
    step(b, 0, 0, 0, ONE, ONE);
    let same = true;
    for (let k = 0; k < L.RNG_WORDS; k++) if (a.i32[L.O_RNG + k] !== b.i32[L.O_RNG + k]) same = false;
    for (let i = 0; i < 96 && same; i++) if (a.i32[base(i) + L.U_HP] !== b.i32[base(i) + L.U_HP] || a.i32[base(i) + L.U_STATE] !== b.i32[base(i) + L.U_STATE]) same = false;
    if (!same) break;
    for (const i of ARMOUR) { tc++; if (a.i32[base(i)] !== b.i32[base(i)] || a.i32[base(i) + 1] !== b.i32[base(i) + 1]) td++; }
  }
  split.push(t);
}

const pct = (a, b) => (r[b] ? (100 * (r[a] || 0) / r[b]).toFixed(2) + '%' : '-');
const med = (a) => { const b = a.slice().sort((x, y) => x - y); return b.length ? b[b.length >> 1].toFixed(1) : '-'; };
const minutes = r['tank-ticks'] / 3600;
console.log(`core ${SRC} (${T ? 'doctrine' : 'no tactics.js'}), seeds ${SEEDS.join(',')}, ${TICKS} ticks`);
console.log(`camping    standing within 8 m of the seam or across  ${pct('camping', 'standing')}  (across ${pct('standing across', 'standing')}), mean standing depth ${(r['standing behind sum'] / r.standing).toFixed(1)} m`);
console.log(`wiggle     z reversals per tank-minute ${(r.reversals / minutes).toFixed(2)}, inside 2 s of the last ${((r.fidgets || 0) / minutes).toFixed(2)} (${pct('fidgets', 'reversals')} of reversals)`);
console.log(`bound      pair depth offset when both stand: median ${med(pairGaps)} m, 12-16 m ${(100 * pairGaps.filter((g) => g >= 12 && g <= 16).length / pairGaps.length).toFixed(1)}% of ${pairGaps.length}; z travel between stops of >= 0.5 s (> 1 m) median ${med(runs)} m of ${runs.length}`);
if (T) {
  const hist = {}; for (const g of postGaps) hist[g] = (hist[g] || 0) + 1;
  console.log(`  posts    the two posts' depth offset at those ticks: ${Object.entries(hist).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([g, n]) => `${g} m ${(100 * n / postGaps.length).toFixed(1)}%`).join(', ')}`);
  console.log(`  camping  on a post pushed within 8 m of the seam ${pct('camping on a pushed post', 'standing')}, off its post ${pct('camping off its post', 'standing')}`);
  console.log(`  hull-down overwatch standing ticks: a >= 0.3 m candidate existed ${(100 * avail.best / avail.n).toFixed(1)}%, the plain hold line had one ${(100 * avail.took / avail.n).toFixed(1)}%, tank within 0.05 m of the best rise ${(100 * avail.atBest / avail.n).toFixed(1)}%`);
}
console.log(`hull-down  standing tank-ticks with >= 0.3 m of rise in front ${pct('hull-down', 'standing')}, mean rise ${(r['rise sum'] / r.standing).toFixed(2)} m` +
  (T ? `; overwatch ${pct('overwatch hull-down', 'overwatch standing')} (mean ${(r['overwatch rise sum'] / r['overwatch standing']).toFixed(2)} m), bounding ${pct('bounding hull-down', 'bounding standing')} (mean ${(r['bounding rise sum'] / r['bounding standing']).toFixed(2)} m)` : ''));
console.log(`standing   ${pct('standing', 'tank-ticks')} of living tank-ticks`);
console.log(`frontage   x span of a side's living tanks (>= 6 alive): median ${med(spans)} m, 10th pct ${spans.slice().sort((a, b) => a - b)[spans.length >> 3 + 0].toFixed(1)} m`);
console.log(`spacing    nearest tank of the same side: median ${med(nearest)} m; closest pair of any side ever ${closest.toFixed(2)} m; within 1 m of each other (same metre) ${pct('same metre', 'same-metre samples')}`);
if (T) {
  console.log(`roles      living tank-ticks overwatch ${pct('role overwatch', 'tank-ticks')} / bounding ${pct('role bounding', 'tank-ticks')} (of all living, incl. widows); pairs both alive with one of each ${pct('pair one of each', 'pair-both-alive')}, sharing a post x ${pct('pair same post x', 'pair-both-alive')}`);
  console.log(`scoot      slot changes ${scoots.n}: nearer the truck ${scoots.toward}, further ${scoots.away}, mean change in distance to it ${(scoots.sum / scoots.n).toFixed(1)} m (truck in its bay); against the mirrored bay nearer ${scoots.mToward}, further ${scoots.mAway}`);
}
console.log(`bubble     tank pairs inside 11.5 m ${pct('inside 11.5', 'pair-ticks')}`);
console.log(`truck      tank positions differing, parked vs driven along the seam: ${td} of ${tc} tank-ticks (worlds split at ticks ${split.join(', ')})`);
