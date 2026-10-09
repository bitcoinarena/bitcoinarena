// WAR_TACTICS.md §4.1 / §4.15 / vocabulary: is the default hold really HULL-DOWN (turret over crest, hull hidden) and do a
// team's two hulls cover the SAME STRETCH of the road (the seam band) FROM DIFFERENT ANGLES? Measured on living-pair
// tank-ticks on post (within 1.5 m of the hold, hull-down pick included, as the H1 row).
//
//     node tools/measure-hulldown-killzone.mjs [--core=DIR/src] [--seeds=1,2,3,4,5] [--ticks=3600]
//
// Hull-down, in the spec's units (§4.15: "two metres hides a hull (3 m) to the turret"): the highest ground in the 6 m
// in front of the hull, toward the enemy (§4.1's look), minus the ground under it. Hull hidden: that crest is >= 2 m.
// Turret over it: the crest is < 3 m. Also: whether a >= 2 m crest existed among the overwatch's five candidates.
// Kill zone: a hull covers the seam x where the seam point is inside its 46 m gun; a pair covers the same stretch when
// the two stretches overlap by >= 27 m (a slot pitch), from different angles when their bearings to the middle of the
// overlap differ by >= 10 degrees. The spec names neither threshold, so the distributions are printed as well.
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const SRC = arg('core', new URL('../src', import.meta.url).pathname);
const SEEDS = arg('seeds', '1,2,3,4,5').split(',').map(Number);
const TICKS = Number(arg('ticks', 3600));
const url = (rel) => pathToFileURL(join(SRC, rel)).href;
const { init, step, groundAt } = await import(url('sim.js'));
const L = await import(url('state.js'));
const T = await import(url('rules/tactics.js'));
const { frontlineZ } = await import(url('rules/frontline.js'));

const ONE = 65536, HX = 130 * ONE, HZ = 85 * ONE, GUN = 46, HULL = 2, TURRET = 3, LOOK = 6;
const base = (i) => L.O_UNITS + i * L.U_WORDS;
const sideOf = (i) => (((i >> 2) & 1) === 0 ? -1 : 1);
const r = {}; const add = (k, n = 1) => { r[k] = (r[k] || 0) + n; };
const crests = [], overlaps = [], angles = [];

for (const seed of SEEDS) {
  const st = init(seed), s = st.i32;
  const seamAt = (x) => frontlineZ(st.tape, x, HX, HZ) / ONE, g = (x, z) => groundAt(st, Math.round(x * ONE), Math.round(z * ONE)) / ONE;
  const crestAt = (x, z, sd) => { const h0 = g(x, z); let top = -Infinity; for (let d = 1; d <= LOOK; d++) top = Math.max(top, g(x, z - sd * d)); return top - h0; };
  for (let t = 0; t < TICKS; t++) {
    step(st, 0, 0, 0, ONE, 0);
    const tick = s[L.O_TICK];
    const onPost = (i) => T.onPost(s, L.O_TACTICS, i, tick, (x) => frontlineZ(st.tape, x, HX, HZ), (x, z) => groundAt(st, x, z));
    const stretch = (x, z) => { let lo = null, hi = null; for (let xm = -81; xm <= 81; xm++) { const dz = seamAt(xm) - z; if (Math.hypot(xm - x, dz) <= GUN) { if (lo === null) lo = xm; hi = xm; } } return lo === null ? null : [lo, hi]; };
    for (let i = 0; i < 96; i += 4) {
      const j = T.partnerOf(i); if (!s[base(i) + L.U_STATE] || j < 0 || !s[base(j) + L.U_STATE]) continue;
      if (!onPost(i)) continue;
      const sd = sideOf(i), x = s[base(i)] / ONE, z = s[base(i) + 1] / ONE, p = T.postOf(s, L.O_TACTICS, i, tick);
      const role = p.bounding ? 'bounding' : 'overwatch';
      const c = crestAt(x, z, sd); crests.push(c);
      add('on post'); add(`${role} on post`);
      const hidden = c >= HULL, over = c < TURRET;
      if (hidden && over) { add('hull-down'); add(`${role} hull-down`); }
      else if (!hidden) add(`not hull-down: crest under 2 m (${role})`); else add(`not hull-down: crest over the turret (${role})`);
      if (!p.bounding) {
        const line = seamAt(p.x / ONE) + sd * p.depth / ONE; let best = -Infinity;
        for (let k = -2; k <= 2; k++) best = Math.max(best, crestAt(p.x / ONE, line + k * 2, sd));
        if (best >= HULL) add('overwatch: a >= 2 m crest existed among its five candidates');
      }
      // kill zone, once per pair (lower index) when both stand on post
      if (j > i && onPost(j)) {
        add('pairs on post');
        const xj = s[base(j)] / ONE, zj = s[base(j) + 1] / ONE;
        const a = stretch(x, z), b = stretch(xj, zj);
        if (!a || !b) { add('pair: a hull reaches no seam'); continue; }
        const lo = Math.max(a[0], b[0]), hi = Math.min(a[1], b[1]), ov = Math.max(0, hi - lo);
        overlaps.push(ov);
        if (ov < 27) { add('pair: overlap under 27 m'); continue; }
        const mx = (lo + hi) / 2, mz = seamAt(Math.round(mx));
        const bi = Math.atan2(mx - x, mz - z), bj = Math.atan2(mx - xj, mz - zj);
        let da = Math.abs(bi - bj) * 180 / Math.PI; if (da > 180) da = 360 - da; angles.push(da);
        if (da >= 10) add('pair: same stretch, different angles'); else add('pair: same stretch, angles under 10 degrees');
      }
    }
  }
}
const pc = (a, b) => (100 * (r[a] || 0) / r[b]).toFixed(1) + '%';
const q = (arr, f) => { const b = arr.slice().sort((u, v) => u - v); return b.length ? b[Math.floor(b.length * f)].toFixed(1) : '-'; };
console.log(`core ${SRC}, seeds ${SEEDS.join(',')}, ${TICKS} ticks`);
console.log(`HULL-DOWN  on-post tank-ticks of living pairs ${r['on post']}: hull hidden and turret over the crest ${pc('hull-down', 'on post')} (overwatch ${pc('overwatch hull-down', 'overwatch on post')}, bounding ${pc('bounding hull-down', 'bounding on post')})`);
for (const k of Object.keys(r).filter((x) => x.startsWith('not hull-down'))) console.log(`           ${k}: ${pc(k, 'on post')}`);
console.log(`           overwatch on post with a >= 2 m crest among its five candidates: ${pc('overwatch: a >= 2 m crest existed among its five candidates', 'overwatch on post')}`);
console.log(`           crest in front of an on-post hull (m): median ${q(crests, 0.5)}, p90 ${q(crests, 0.9)}, p99 ${q(crests, 0.99)}`);
console.log(`KILL ZONE  pair-ticks with both on post ${r['pairs on post']}: same stretch (>= 27 m overlap) from different angles (>= 10 deg) ${pc('pair: same stretch, different angles', 'pairs on post')}`);
for (const k of Object.keys(r).filter((x) => x.startsWith('pair: ') && x !== 'pair: same stretch, different angles')) console.log(`           ${k}: ${pc(k, 'pairs on post')}`);
console.log(`           overlap (m): median ${q(overlaps, 0.5)}, p10 ${q(overlaps, 0.1)}; bearing difference (deg): median ${q(angles, 0.5)}, p10 ${q(angles, 0.1)}`);
