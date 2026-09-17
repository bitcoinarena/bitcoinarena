// WAR_TACTICS.md §4.1 HULL-DOWN HYSTERESIS - the table the letter is decided on, on the core as it runs now: the scrolled
// seam (frontAt), live-style samples every 300 ticks, seeds x ticks, truck parked.
//
//     node tools/measure-hulldown-hysteresis.mjs [--seeds=1,2,3,4,5] [--ticks=3600]
//
// wiggle     §0 row 2 on tanks on the line (living, within 40 m in z of their post line): a flip is the sign of the
//            tank's OWN step (st.trace: the step the army rule took, outside separation - §0's ruled reading) reversing
//            in x or z between two ticks it stepped > 0.02 m; a fidget is a flip inside 120 ticks (2 s) of its previous
//            one; the row passes at fidgets < 2% of flips. The same on position deltas (separation included) is
//            printed beside it.
//            Also: on-post tank-ticks (within 1.5 m of the hold) whose step is >= 0.02 m (row 2's first half).
// switches   an overwatch tank's crest pick (hold - line) changing by > 0.5 m on a tick its post (slot x, depth, role)
//            did not change - the search picking another candidate, per seed.
// hull-down  (a) the pre-ribbon number's definition: living-pair tank-ticks on post with the crest in the 6 m toward the
//            enemy >= 2 m and < 3 m (hull hidden, turret over); (b) the search's own unit: overwatch on-post tank-ticks
//            with >= 0.3 m of rise in front.
// H1         living-pair tank-ticks within 1.5 m of the hold (T.onPost).
import { init, step, groundAt, frontAt, submitSample, setCandleField } from '../src/sim.js';
import * as L from '../src/state.js';
import * as T from '../src/rules/tactics.js';
import { hullDownHold } from '../src/rules/army.js';
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const SEEDS = arg('seeds', '1,2,3,4,5').split(',').map(Number), TICKS = Number(arg('ticks', 3600)), FLAT = process.argv.includes('--flat');
const ONE = 65536, base = (i) => L.O_UNITS + i * L.U_WORDS, sideOf = (i) => (((i >> 2) & 1) === 0 ? -1 : 1);
const r = {}; const add = (k, n = 1) => { r[k] = (r[k] || 0) + n; };
const perSeed = [];
for (const seed of SEEDS) {
  const st = init(seed); if (FLAT) setCandleField(st, false);
  st.trace = { dx: new Int32Array(24), dz: new Int32Array(24) };
  const s = st.i32, open = s[L.O_TACTICS + T.TAC_MARKET + T.MK_OPEN];
  const seamAt = (x) => frontAt(st, x), ground = (x, z) => groundAt(st, x, z);
  const g = (x, z) => groundAt(st, Math.round(x * ONE), Math.round(z * ONE)) / ONE;
  const prev = new Map(); let switches = 0;
  for (let t = 1; t <= TICKS; t++) {
    if (t % 300 === 0) submitSample(st, open + ((t * 7919) % 801) - 400);        // a live-style walk, 5 s apart
    step(st, 0, 0, 0, ONE, 0);
    const tick = s[L.O_TICK];
    for (let i = 0; i < 96; i += 4) {
      if (!s[base(i) + L.U_STATE] || s[base(i) + L.U_HP] <= 0) { prev.delete(i); continue; }
      const sd = sideOf(i), x = s[base(i)], z = s[base(i) + 1], p = T.postOf(s, L.O_TACTICS, i, tick);
      const line = seamAt(p.x) + sd * p.depth;
      const hold = p.bounding ? line : (T.crestHold ? T.crestHold(s, L.O_TACTICS, i, p, line, sd, ground) : hullDownHold(line, sd, p.x, ground));
      const onLine = Math.abs(z - line) <= 40 * ONE;
      const onPost = Math.hypot((x - p.x) / ONE, (z - hold) / ONE) <= 1.5;
      const j = T.partnerOf(i), pair = j >= 0 && s[base(j) + L.U_STATE] && s[base(j) + L.U_HP] > 0;
      const q = prev.get(i);
      if (q) {
        const dx = (x - q.x) / ONE, dz = (z - q.z) / ONE, moved = Math.hypot(dx, dz);
        if (onPost) { add('on-post ticks'); if (moved >= 0.02) add('on-post moving'); }
        if (onLine && moved > 0.02) {
          for (const [axis, d] of [['x', dx], ['z', dz]]) {
            if (Math.abs(d) < 1e-6) continue;
            const sg = Math.sign(d), was = q[`s${axis}`];
            if (was && was !== sg) { add('pos flips'); if (q.lastFlip !== undefined && tick - q.lastFlip < 120) add('pos fidgets'); q.lastFlip = tick; }
            q[`s${axis}`] = sg;
          }
        }
        const ox = st.trace.dx[i >> 2] / ONE, oz = st.trace.dz[i >> 2] / ONE;
        if (onLine && Math.hypot(ox, oz) > 0.02) {
          for (const [axis, d] of [['x', ox], ['z', oz]]) {
            if (Math.abs(d) < 1e-6) continue;
            const sg = Math.sign(d), was = q[`o${axis}`];
            if (was && was !== sg) {
              const role = p.bounding ? 'bounding' : 'overwatch';
              add('flips'); add(`flips ${axis} ${role}`);
              if (q.lastOwn !== undefined && tick - q.lastOwn < 120) {
                add('fidgets'); add(`fidgets ${axis} ${role}`);
                if (axis === 'z') {
                  // WHY: did the hold itself reverse inside the 2 s (the line following the seam), or stand still?
                  const holdFlip = q.holdFlipAt !== undefined && tick - q.holdFlipAt < 120;
                  const holdMoved = q.holdMovedAt !== undefined && tick - q.holdMovedAt < 120;
                  add(`z fidget: ${holdFlip ? 'the hold reversed' : holdMoved ? 'the hold moved one way' : 'the hold stood'}`);
                  const off = Math.abs(z - hold) / ONE; add('z fidget off hold sum', off);
                }
              }
              q.lastOwn = tick;
            }
            q[`o${axis}`] = sg;
          }
        }
        if (!p.bounding && !q.bounding && q.px === p.x && q.depth === p.depth && Math.abs((hold - line) - q.pick) > ONE / 2) switches++;
      }
      if (pair) {
        add('pair ticks'); if (onPost) add('H1 within 1.5 m');
        if (onPost) {
          const xm = x / ONE, zm = z / ONE, h0 = g(xm, zm); let top = -Infinity;
          for (let d = 1; d <= 6; d++) top = Math.max(top, g(xm, zm - sd * d));
          const c = top - h0; add('pair on post'); if (c >= 2 && c < 3) add('hull-down (a)');
          if (!p.bounding) { add('overwatch on post'); if (c >= 0.3) add('hull-down (b)'); }
        }
      }
      let holdFlipAt = q ? q.holdFlipAt : undefined, holdMovedAt = q ? q.holdMovedAt : undefined, holdSign = q ? q.holdSign : 0;
      if (q && q.hold !== undefined) {
        const dh = hold - q.hold;
        if (Math.abs(dh) > 64) { holdMovedAt = tick; const sg = Math.sign(dh); if (holdSign && sg !== holdSign) holdFlipAt = tick; holdSign = sg; }
      }
      prev.set(i, { hold, holdFlipAt, holdMovedAt, holdSign, x, z, sx: q ? q.sx : 0, sz: q ? q.sz : 0, lastFlip: q ? q.lastFlip : undefined, ox: q ? q.ox : 0, oz: q ? q.oz : 0, lastOwn: q ? q.lastOwn : undefined, bounding: p.bounding, px: p.x, depth: p.depth, pick: hold - line });
    }
    add('tank-ticks', prev.size);
  }
  perSeed.push(switches);
}
const pc = (a, b) => `${(100 * (r[a] || 0) / (r[b] || 1)).toFixed(2)}%`;
const minutes = r['tank-ticks'] / 3600;
console.log(`seeds ${SEEDS.join(',')} x ${TICKS} ticks, samples every 300, truck parked${FLAT ? ', CANDLE FIELD OFF' : ''}`);
console.log('raw ' + JSON.stringify({ ...r, switches: perSeed }));
console.log(`wiggle     own step (the row): flips ${r.flips || 0}, fidgets ${r.fidgets || 0} = ${pc('fidgets', 'flips')} of flips (row: < 2%), flips per tank-minute ${((r.flips || 0) / minutes).toFixed(2)}; on positions (separation included): ${pc('pos fidgets', 'pos flips')} of ${r['pos flips'] || 0}; on-post ticks moving >= 0.02 m ${pc('on-post moving', 'on-post ticks')}`);
console.log(`  by axis and role: ${['x', 'z'].flatMap((ax) => ['overwatch', 'bounding'].map((ro) => `${ax} ${ro} ${r[`fidgets ${ax} ${ro}`] || 0}/${r[`flips ${ax} ${ro}`] || 0}`)).join(', ')} (fidgets/flips)`);
console.log(`  z fidgets: ${['the hold reversed', 'the hold moved one way', 'the hold stood'].map((k) => `${k} ${r[`z fidget: ${k}`] || 0}`).join(', ')}; mean distance from the hold at a z fidget ${((r['z fidget off hold sum'] || 0) / Math.max(1, (r['z fidget: the hold reversed'] || 0) + (r['z fidget: the hold moved one way'] || 0) + (r['z fidget: the hold stood'] || 0))).toFixed(2)} m`);
console.log(`switches   overwatch crest picks changed on an unchanged post, per seed: ${perSeed.join(' / ')} (sum ${perSeed.reduce((a, b) => a + b, 0)})`);
console.log(`hull-down  (a) crest 2-3 m, pair on post ${pc('hull-down (a)', 'pair on post')}; (b) overwatch on post with >= 0.3 m rise ${pc('hull-down (b)', 'overwatch on post')}`);
console.log(`H1         pair tank-ticks within 1.5 m of the hold ${pc('H1 within 1.5 m', 'pair ticks')}`);
