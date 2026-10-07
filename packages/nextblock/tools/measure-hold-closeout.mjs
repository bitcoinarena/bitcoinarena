// Hold-is-the-default close-out (WAR_TACTICS.md §0 H1/H2, 2026-09-16): stop distance on post, posts moved under an
// off-post tank, hull-down share of on-post ticks and whether a crest existed. Seeds 1-5 x 3600.
//     node tools/measure-hold-closeout.mjs
const C = new URL('../src/', import.meta.url).pathname;
const { init, step, groundAt } = await import(C + 'sim.js');
const L = await import(C + 'state.js');
const T = await import(C + 'rules/tactics.js');
const { frontlineZ } = await import(C + 'rules/frontline.js');
const ONE = 65536, HX = 130 * ONE, HZ = 85 * ONE;
const base = (i) => L.O_UNITS + i * L.U_WORDS;
const sideOf = (i) => (((i >> 2) & 1) === 0 ? -1 : 1);
const stop = [], r = {}; const add = (k, n = 1) => { r[k] = (r[k] || 0) + n; };
for (const seed of [1, 2, 3, 4, 5]) {
  const st = init(seed), s = st.i32; const seamAt = (x) => frontlineZ(st.tape, x, HX, HZ), g = (x, z) => groundAt(st, x, z);
  const postWas = new Map();
  for (let t = 0; t < 3600; t++) {
    const pre = []; for (let i = 0; i < 96; i += 4) pre[i] = [s[base(i)], s[base(i) + 1]];
    step(st, 0, 0, 0, ONE, 0); const tick = s[L.O_TICK];
    for (let i = 0; i < 96; i += 4) {
      const j = T.partnerOf(i); if (!s[base(i) + L.U_STATE] || j < 0 || !s[base(j) + L.U_STATE]) { postWas.delete(i); continue; }
      const p = T.postOf(s, L.O_TACTICS, i, tick), sd = sideOf(i), line = seamAt(p.x) + sd * p.depth;
      let hold = line, best = -Infinity, atLine = 0;
      for (let c = -2; c <= 2; c++) { const z = line + c * 2 * ONE; const rise = (g(p.x, z - sd * 6 * ONE) - g(p.x, z)) / ONE; if (c === 0) atLine = rise; if (rise > best) { best = rise; if (!p.bounding) hold = z; } }
      const d = Math.hypot(s[base(i)] - p.x, s[base(i) + 1] - hold) / ONE;
      const standing = Math.hypot(s[base(i)] - pre[i][0], s[base(i) + 1] - pre[i][1]) < 0.02 * ONE;
      // posts sliding mid-leg: a post change (x or depth) while the tank is still off post and the change is not a leg swap
      const pw = postWas.get(i);
      if (pw && (pw.x !== p.x || pw.depth !== p.depth) && pw.bounding === p.bounding && pw.off) add('post moved under an off-post tank (not a swap)');
      if (pw && (pw.x !== p.x || pw.depth !== p.depth)) add('post changes');
      postWas.set(i, { x: p.x, depth: p.depth, bounding: p.bounding, off: d > 1.5 });
      if (d > 1.5) continue;
      add('on post'); if (standing) { add('on post standing'); stop.push(d); }
      const rise = (g(s[base(i)], s[base(i) + 1] - sd * 6 * ONE) - g(s[base(i)], s[base(i) + 1])) / ONE;
      const role = p.bounding ? 'bounding' : 'overwatch';
      add(`${role} on post`);
      if (rise >= 0.3) add(`${role} hull-down (>= 0.3 m rise in front)`);
      if (best >= 0.3) add(`${role} a >= 0.3 m crest existed among the 5 candidates`);
      const seamZ = seamAt(s[base(i)]); const behind = (s[base(i) + 1] - seamZ) * sd / ONE;
      if (Math.abs(behind) > 46) add(`${role} gun does not reach the seam at its own x`);
      if (behind < 0) add(`${role} across the seam`);
    }
  }
}
const q = (a, f) => { const b = a.slice().sort((x, y) => x - y); return b[Math.floor(b.length * f)].toFixed(2); };
console.log(`stop distance of standing tanks on post (m): median ${q(stop, 0.5)}, p90 ${q(stop, 0.9)}, max ${q(stop, 0.999)}`);
for (const [k, v] of Object.entries(r).sort()) console.log(`${String(v).padStart(7)}  ${k}`);
