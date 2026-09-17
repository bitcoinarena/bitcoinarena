// WAR_TACTICS.md §0 wiggle row, BY CAUSE: every fidget of a tank's own step, put in exactly one bucket by what the army
// step did in the 2 s it spans (sim.js st.trace, probe-only: which rule set the step, the hold, the slot x).
//
// A flip is the sign of the tank's own x or z step reversing between two ticks it stepped > 0.02 m, on the line (within
// 40 m in z of its post line); a fidget is a flip inside 120 ticks of the tank's previous one. Buckets, first match wins:
//   back-off      the overrun fall-back, the crowded back-off or the hold after giving ground ran on a tick of the window
//   budget        the line budget held the tank on some ticks of the window and not on others
//   walking in    the tank has not stood within 1.5 m of its hold since this post (slot x, depth, role) was set
//   arrived-chase it had stood within 1.5 m of its hold since the post was set, and the hold moved > 0.02 m on a tick of
//                 the window
//   other         none of these
//
// MEASURED ON A COPY (as measure-war.mjs): the core is copied to a temp directory and the probe's view - which rule set
// the step, the hold, the slot x, the step asked and the step driven - is patched into the COPY at named anchors. The
// shipped core carries none of it. A moved anchor stops the tool with the anchor's text.
//
//     node tools/measure-fidget-causes.mjs [--core=DIR] [--seeds=1,2,3,4,5] [--ticks=3600]
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const CORE = arg('core', new URL('..', import.meta.url).pathname);
const tmp = mkdtempSync(join(tmpdir(), 'measure-fidget-'));
cpSync(join(CORE, 'src'), join(tmp, 'src'), { recursive: true });
const patch = (rel, anchor, insert, where = 'after') => {
  const p = join(tmp, 'src', rel); const s = readFileSync(p, 'utf8');
  if (s.split(anchor).length !== 2) { console.error(`measure-fidget-causes: anchor not found once in ${rel}:\n${anchor}`); process.exit(2); }
  writeFileSync(p, s.replace(anchor, where === 'after' ? anchor + insert : insert + anchor));
};
// which rule set the step: 1 overrun fall-back, 2 crowded back-off, 4 holding after giving ground, 8 walking to the
// hold, 16 crossing to the slot, 32 held by the line budget
patch('rules/army.js', '  let gaveGround = u.armour && u.crowdedLoose ? ((u.cooldown | 0) >> 5) & 1 : 0;\n', '  u.why = 0; u.whyHold = hold;\n');
patch('rules/army.js', '  if (overrun) {\n', '    u.why = 1;\n');
patch('rules/army.js', '    gaveGround = 1;\n', '    u.why = 2;\n');
patch('rules/army.js', '  } else {\n    const gap = sub(hold, u.z);\n', '    u.why = 4;\n', 'before');
patch('rules/army.js', '  }\n  // Sideways: hold a squad position, not a random walk.\n', '    u.why = crossing ? 24 : 8;\n', 'before');
patch('rules/army.js', '  if (u.armour && u.tacWait) dz = 0;', '  if (u.armour && u.tacWait) u.why |= 32;\n', 'before');
patch('rules/army.js', '  const edge = sub(FRONT_X, Math.imul(4, ONE));\n', '  u.whyDx = dx; u.whyDz = dz; u.whyStepX = stepX; u.whyStepZ = stepZ;\n', 'before');
patch('sim.js', 'if (st.trace && u.armour) { st.trace.dx[i >> 2] = sub(u.x, s[b + U_X]); st.trace.dz[i >> 2] = sub(u.z, s[b + U_Z]); }',
  '\n    if (st.trace && st.trace.why && u.armour) { const k = i >> 2; st.trace.why[k] = u.why | 0; st.trace.hold[k] = u.whyHold | 0; st.trace.tacX[k] = u.tacX | 0;'
  + ' st.trace.ask[i] = u.whyDx | 0; st.trace.ask[i + 1] = u.whyDz | 0; st.trace.ask[i + 2] = u.whyStepX | 0; st.trace.ask[i + 3] = u.whyStepZ | 0; }');
const url = (rel) => pathToFileURL(join(tmp, 'src', rel)).href;
const { init, step, frontAt, submitSample } = await import(url('sim.js'));
const L = await import(url('state.js'));
const T = await import(url('rules/tactics.js'));
const SEEDS = arg('seeds', '1,2,3,4,5').split(',').map(Number), TICKS = Number(arg('ticks', 3600));
const ONE = 65536, base = (i) => L.O_UNITS + i * L.U_WORDS, sideOf = (i) => (((i >> 2) & 1) === 0 ? -1 : 1);
const r = { flips: 0, fidgets: 0 }; const add = (k, n = 1) => { r[k] = (r[k] || 0) + n; };
const BUCKETS = ['back-off', 'budget', 'walking in', 'arrived-chase', 'other'];
for (const seed of SEEDS) {
  const st = init(seed), s = st.i32, open = s[L.O_TACTICS + T.TAC_MARKET + T.MK_OPEN];
  st.trace = { dx: new Int32Array(24), dz: new Int32Array(24), why: new Int32Array(24), hold: new Int32Array(24), tacX: new Int32Array(24), ask: new Int32Array(96) };
  const tk = new Map();
  for (let t = 1; t <= TICKS; t++) {
    if (t % 300 === 0) submitSample(st, open + ((t * 7919) % 801) - 400);
    step(st, 0, 0, 0, ONE, 0);
    const tick = s[L.O_TICK];
    for (let i = 0; i < 96; i += 4) {
      const k = i >> 2;
      if (!s[base(i) + L.U_STATE] || s[base(i) + L.U_HP] <= 0) { tk.delete(i); continue; }
      const p = T.postOf(s, L.O_TACTICS, i, tick), sd = sideOf(i);
      const line = frontAt(st, p.x) + sd * p.depth;
      const why = st.trace.why[k], hold = st.trace.hold[k], x = s[base(i)], z = s[base(i) + 1];
      const key = `${p.x}:${p.depth}:${p.bounding}`;
      let q = tk.get(i);
      if (q && (Math.abs(x - q.px) > 3 * ONE || Math.abs(z - q.pz) > 3 * ONE)) { add('respawns seen'); q = undefined; }
      if (!q || q.key !== key) {
        const what = !q ? 'spawn' : [q.p.x !== p.x ? 'slot x' : '', q.p.depth !== p.depth ? 'depth' : '', q.p.bounding !== p.bounding ? 'role' : ''].filter(Boolean).join('+');
        q = { ...(q || {}), key, p, arrived: false, hist: q ? q.hist : [], set: tick, what, jump: q ? Math.abs(hold - q.hold) / ONE : 0, hold: q ? q.hold : hold };
      }
      if (Math.abs(z - hold) / ONE <= 1.5) q.arrived = true;   // the hold is a depth: the line the tank stands on
      const holdMoved = Math.abs(hold - q.hold) / ONE;
      q.hist.push({ tick, why, holdMoved, arrived: q.arrived });
      while (q.hist.length && tick - q.hist[0].tick > 120) q.hist.shift();
      q.hold = hold;
      const ox = st.trace.dx[k] / ONE, oz = st.trace.dz[k] / ONE;
      if (Math.abs(z - line) <= 40 * ONE && Math.hypot(ox, oz) > 0.02) {
        for (const [axis, d] of [['x', ox], ['z', oz]]) {
          if (Math.abs(d) < 1e-6) continue;
          const sg = Math.sign(d), was = q[`o${axis}`];
          if (was && was !== sg) {
            r.flips++;
            const stampNow = (s[base(i) + L.U_COOLDOWN] >>> 8) | 0;
            q[`prev${axis}`] = { oldRunHow: [...(q[`runhow${axis}`] || [])].sort().join(','), oldRunAsked: !!q[`run${axis}`], stamped: stampNow === tick - 1 || stampNow === tick };
            if (q.last !== undefined && tick - q.last < 120) {
              r.fidgets++; add(`fidgets ${axis}`);
              // ONE TURN OR TWO: the other axis turned on this same tick (one diagonal reversal, counted as a flip and a
              // fidget), and whether either of the two turns was a component under 5 mm (heading noise on a straight drive).
              add(`SHAPE|${tick === q.last ? 'same tick as the other axis' : 'later tick'}|${Math.min(Math.abs(d), q.lastMag) < 0.005 ? 'a turn under 5 mm' : 'both turns 5 mm or more'}`);
              const w = q.hist.filter((h) => h.tick >= q.last);
              const backoff = w.some((h) => (h.why & 7) !== 0);
              const held = w.some((h) => (h.why & 32) !== 0), free = w.some((h) => (h.why & 32) === 0);
              const bucket = backoff ? 'back-off' : held && free ? 'budget' : !q.arrived ? 'walking in'
                : w.some((h) => h.holdMoved > 0.02) ? 'arrived-chase' : 'other';
              add(bucket); add(`${bucket} ${axis}`);
              if (tick === q.last) {
                add('same tick'); add(`${bucket} same tick`);
                // which axis carried the small part, and how far the hull stood off the nearer axis (65536 a turn)
                const hd = s[base(i) + L.U_HEADING], offZ = Math.min(hd & 32767, 32768 - (hd & 32767)), offX = Math.min((hd + 16384) & 32767, 32768 - ((hd + 16384) & 32767));
                const small = Math.min(Math.abs(ox), Math.abs(oz)), off = Math.abs(ox) < Math.abs(oz) ? offZ : offX;
                add(`TWIN|${Math.abs(ox) < Math.abs(oz) ? 'x small (driving along z)' : 'z small (driving along x)'}|off the axis ${off === 0 ? '0' : off <= 27 ? '1-27 (a turn step rounds to 0)' : off <= 546 ? '28-546 (under 3 deg)' : 'over 3 deg'}|small part ${small < 0.005 ? '< 5 mm' : '>= 5 mm'}`);
              }
              // HOW the own step turned round, at the fidget tick: the controller asked it (the asked dx/dz sign is the new
              // sign), the hull carried it (asked nothing or the old way on this axis, the step along the heading turned),
              // or something after the step pushed it (crater, map edge).
              const ask = st.trace.ask[k * 4 + (axis === 'x' ? 0 : 1)], drv = st.trace.ask[k * 4 + (axis === 'x' ? 2 : 3)];
              const how = Math.sign(ask) === sg ? 'asked' : Math.sign(drv) === sg ? 'carried' : 'pushed';
              add(`${bucket}|${axis}|${q[`h${axis}`]} then ${how}`);
              add(`${bucket}|${axis}|${(why & 16) ? 'crossing' : 'on its slot'}`);
              // THE GUARD'S CLOCK (army.js ONE REVERSAL IN TWO SECONDS): the tick it last stamped a reversal of the ASKED
              // direction, before this step, against the tick the hull's own step last turned round (q.last).
              { const stamp = (q.mem >>> 8) | 0; add(`${bucket}|guard stamp before the hull's last flip by`, 0);
                add(`${bucket} lead sum`, q.last - stamp); add(`${bucket}|guard stamped ${q.last - stamp > 0 ? 'earlier' : q.last - stamp < 0 ? 'later' : 'same tick'}`); }
              { const stamp = (q.mem >>> 8) | 0, askNow = Math.sign(st.trace.ask[k * 4 + (axis === 'x' ? 0 : 1)]) === sg;
                const mech = !askNow ? 'this turn carried by the hull (not asked on this axis)'
                  : (q.lastInfo && !q.lastInfo.oldRunAsked) ? 'asked, the old way was carried by the hull'
                  : tick - 1 - stamp >= 120 ? `asked, guard clock ran out (stamped ${q.last - stamp} ticks before the hull turned)` : 'asked inside the guard clock';
                add(`MECH|${bucket}|${mech.replace(/\d+ ticks/, 'N ticks')}`); if (mech.includes('old way was carried')) add(`OLDRUN|${axis}|${q.lastInfo.oldRunHow}`); if (mech.startsWith('asked, guard')) add('lag sum', q.last - stamp); }
              { const pv = q.lastInfo || {}; add(`ALL|previous hull turn: old run asked ${pv.oldRunAsked}, guard stamped it ${pv.stamped}`); }
              if (bucket === 'walking in') { add(`walking in|${axis}|post changed ${q.what}${tick - q.set < 120 ? ' inside the 2 s' : ' before the 2 s'}`); add(`walk jump sum ${axis}`, q.jump); add(`walk since sum ${axis}`, tick - q.set); }
              if (bucket === 'other') add(`other dist sum`, Math.abs(z - hold) / ONE);
            }
            q.last = tick; q.lastMag = Math.abs(d); q.lastInfo = q[`prev${axis}`]; q[`run${axis}`] = false; q[`runhow${axis}`] = new Set();
          }
          q[`o${axis}`] = sg;
          if (Math.sign(st.trace.ask[k * 4 + (axis === 'x' ? 0 : 1)]) === sg) q[`run${axis}`] = true;
          q[`runhow${axis}`] = (q[`runhow${axis}`] || new Set()).add(q[`h${axis}`] + ((why & 16) ? '/crossing' : '') + ((why & 7) ? '/backoff' : ''));
          { const ask = st.trace.ask[k * 4 + (axis === 'x' ? 0 : 1)], drv = st.trace.ask[k * 4 + (axis === 'x' ? 2 : 3)];
            q[`h${axis}`] = Math.sign(ask) === sg ? 'asked' : Math.sign(drv) === sg ? 'carried' : 'pushed';
            if (axis === 'z' && q.hz === 'carried' && Math.abs(d) > 0.02) { add('carried z ticks'); const f = (v) => (v / ONE).toFixed(3);
              add(`CARRIED|askX ${Math.abs(st.trace.ask[k * 4]) > 0 ? 'moving' : 'zero'} askZ ${st.trace.ask[k * 4 + 1] === 0 ? 'zero' : 'other way'} why ${why}`);
              if ((r.shownCarried = (r.shownCarried || 0) + 1) <= 8) console.log(`seed ${seed} tank ${k} tick ${tick} askX ${f(st.trace.ask[k * 4])} askZ ${f(st.trace.ask[k * 4 + 1])} stepX ${f(st.trace.ask[k * 4 + 2])} stepZ ${f(st.trace.ask[k * 4 + 3])} own ${ox.toFixed(3)},${oz.toFixed(3)} heading ${s[base(i) + L.U_HEADING]} why ${why}`); } }
        }
      }
      q.mem = s[base(i) + L.U_COOLDOWN]; q.px = x; q.pz = z;
      tk.set(i, q);
    }
  }
}
const of = (n) => `${n} of ${r.fidgets} fidgets = ${(100 * n / r.flips).toFixed(2)} points of the ${(100 * r.fidgets / r.flips).toFixed(2)}%`;
console.log(`seeds ${SEEDS.join(',')} x ${TICKS}, samples every 300, truck parked: own-step flips ${r.flips}, fidgets ${r.fidgets} (${(100 * r.fidgets / r.flips).toFixed(2)}%; z ${r['fidgets z'] || 0}, x ${r['fidgets x'] || 0})`);
for (const b of BUCKETS) console.log(`  ${b.padEnd(14)} ${of(r[b] || 0)}  (z ${r[`${b} z`] || 0}, x ${r[`${b} x`] || 0})`);
if (r.other) console.log(`  other: mean distance from the hold at the fidget ${(r['other dist sum'] / r.other).toFixed(2)} m`);
for (const k of Object.keys(r).filter((k) => k.includes('|')).sort()) console.log(`    ${k.padEnd(52)} ${r[k]}`);
console.log(`  walking in: mean hold jump at the post change z ${(r['walk jump sum z'] / r['walking in z']).toFixed(2)} m, mean ticks since the post was set z ${(r['walk since sum z'] / r['walking in z']).toFixed(0)}`);
for (const b of BUCKETS) if (r[b]) console.log(`  ${b}: the guard stamped its reversal a mean ${(r[`${b} lead sum`] / r[b]).toFixed(1)} ticks before the hull's own step turned`);
console.log(`respawns seen ${r['respawns seen'] || 0}; mean guard lag where the clock ran out ${(r['lag sum'] / Object.entries(r).filter(([k]) => k.includes('clock ran out')).reduce((a, [, v]) => a + v, 0)).toFixed(1)} ticks`);
console.log(`ONE TURN ON BOTH AXES IN ONE TICK (the other axis turned on this same tick): ${r['same tick'] || 0} of ${r.fidgets} fidgets = ${(100 * (r['same tick'] || 0) / r.flips).toFixed(2)} points of the ${(100 * r.fidgets / r.flips).toFixed(2)}%; `
  + BUCKETS.map((b) => `${b} ${r[`${b} same tick`] || 0} of ${r[b] || 0}`).join(', '));
