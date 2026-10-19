// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WAR_TACTICS.md §0 "Hold is the default" - WHY a tank of a living pair is off post, and why a leg's bounding tank
// does not arrive. The bars are in measure-war.mjs (H1, H2); this is the breakdown of the gap.
//
//     node tools/measure-hold.mjs [--core=DIR] [--seeds=1,2,3,4,5] [--ticks=3600]
//
// On post = within 1.5 m of the hold: slot x, its line, the hull-down pick for an overwatch tank (§4.1), as H1.
// Every tank carries the cause of its last post change - leg swap (§2.6), push step (§4.10), scoot (§4.3), spawn -
// and whether it has stood on post since. An off-post tick is charged to that cause while the tank has not yet
// arrived. A tank that arrived and is off post again is "left post", split by the army code path that holds or
// moves it this tick (hooked on a copy of the core, as measure-war.mjs does). Stops inside the core's 2 m lateral
// deadband (depth on post, x 1.5-2.0 m off, not moving) are counted inside each cause as well.
//
// A leg (a role change of a pair with both alive) whose new bounding tank never stood on post before the next role
// change is a failed leg: "redirected" when its post moved during the leg other than by the swap itself (push step
// or scoot), "never given a post" when it was not on the line (> 40 m from its post) at the leg's start or died in
// it, else "short when the leg ended" - split by what it was doing on the leg's last tick.
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const CORE = arg('core', new URL('..', import.meta.url).pathname);
const SEEDS = arg('seeds', '1,2,3,4,5').split(',').map(Number);
const TICKS = Number(arg('ticks', 3600));

const tmp = mkdtempSync(join(tmpdir(), 'measure-hold-'));
cpSync(join(CORE, 'src'), join(tmp, 'src'), { recursive: true });
const pa = join(tmp, 'src/rules/army.js'); let army = readFileSync(pa, 'utf8');
const patch = (anchor, insert, where = 'after') => {
  if (army.split(anchor).length !== 2) { console.error(`measure-hold: anchor not found once in army.js:\n${anchor}`); process.exit(2); }
  army = army.replace(anchor, where === 'after' ? anchor + insert : insert + anchor);
};
patch('  if (overrun) {\n', '    globalThis.__H.branch = "overrun fall-back";\n');
patch('  } else if (u.crowded) {\n', '    globalThis.__H.branch = "crowded (gives 6 m)";\n');
patch('    dz = 0;\n  } else {\n', '    globalThis.__H.branch = "hold line";\n');
patch("    const want = !crossing && abs(gap) > band ? (gap > 0 ? ONE : -ONE) : 0;\n", "    if (crossing) globalThis.__H.branch = 'crossing to its slot x';\n");
patch('  } else if (u.armour && u.crowdedLoose && gaveGround && mulFast(sub(u.z, hold), Math.imul(side, ONE)) > 0) {\n', '    globalThis.__H.branch = "gave ground, holds";\n');
patch('  u.z = clamp(add(u.z, stepZ), -halfZ, halfZ);\n',
  '  if (globalThis.__H.unit) globalThis.__H.unit(index, { branch: globalThis.__H.branch, wait: !!u.tacWait, dx, dz, stepX, stepZ });\n');
writeFileSync(pa, army);

const hook = new Map();
globalThis.__H = { branch: '', unit: (i, v) => hook.set(i, v) };
const url = (rel) => pathToFileURL(join(tmp, 'src', rel)).href;
const { init, step, groundAt } = await import(url('sim.js'));
const L = await import(url('state.js'));
const T = await import(url('rules/tactics.js'));
const { frontlineZ } = await import(url('rules/frontline.js'));

const ONE = 65536, HX = 130 * ONE, HZ = 85 * ONE;
const base = (i) => L.O_UNITS + i * L.U_WORDS;
const sideOf = (i) => (((i >> 2) & 1) === 0 ? -1 : 1);
const r = {}; const add = (k, n = 1) => { r[k] = (r[k] || 0) + n; };

for (const seed of SEEDS) {
  const st = init(seed), s = st.i32;
  const seamAt = (x) => frontlineZ(st.tape, x, HX, HZ), ground = (x, z) => groundAt(st, x, z);
  const tank = new Map();      // i -> { post: {x, bounding, push}, cause, arrived }
  const legs = new Map();      // lower index of a pair -> open leg
  const roleWas = new Map();
  for (let t = 0; t < TICKS; t++) {
    const pre = new Map(); for (let i = 0; i < 96; i += 4) pre.set(i, [s[base(i)], s[base(i) + 1], s[base(i) + L.U_STATE]]);
    hook.clear();
    step(st, 0, 0, 0, ONE, 0);
    const tick = s[L.O_TICK];
    const holdOf = (i, p) => { const sd = sideOf(i); const line = seamAt(p.x) + sd * p.depth; if (p.bounding) return line;
      let best = line, br = -Infinity; for (let c = -2; c <= 2; c++) { const z = line + c * 2 * ONE; const rise = ground(p.x, z - sd * 6 * ONE) - ground(p.x, z); if (rise > br) { br = rise; best = z; } } return best; };
    const view = new Map();
    for (let i = 0; i < 96; i += 4) {
      if (!s[base(i) + L.U_STATE]) { tank.delete(i); continue; }
      const p = T.postOf(s, L.O_TACTICS, i, tick), hz = holdOf(i, p);
      const ex = Math.abs(s[base(i)] - p.x), ez = Math.abs(s[base(i) + 1] - hz);
      const on = Math.hypot(ex, ez) <= 1.5 * ONE;
      const q = pre.get(i), moved = q[2] && Math.hypot(s[base(i)] - q[0], s[base(i) + 1] - q[1]) >= 0.02 * ONE;
      let tk = tank.get(i);
      if (!tk || !q[2]) { tk = { post: p, cause: 'spawn walk-in', arrived: false }; tank.set(i, tk); }
      else {
        const was = tk.post; let cause = null;
        if (was.x !== p.x) cause = 'scoot';
        else if (was.bounding !== p.bounding) cause = 'bound (leg swap)';
        else if (was.push !== p.push) cause = 'push step';
        if (cause) { if (!tk.arrived) add(`stacked: ${cause} over an unfinished ${tk.cause}`); tk.cause = cause; tk.arrived = false; }
        tk.post = p;
      }
      if (on) tk.arrived = true;
      const deadband = !on && !moved && ez <= 1.5 * ONE && ex > 1.5 * ONE && ex <= 2.05 * ONE;
      view.set(i, { p, on, moved, deadband, onLine: Math.abs(s[base(i) + 1] - hz) <= 40 * ONE, tk });
    }
    // ---- 2. off-post ticks of living pairs ----
    for (const [i, v] of view) {
      const j = T.partnerOf(i); if (j < 0 || !view.has(j)) continue;
      add('pair tank-ticks');
      if (v.on) { add('on post'); continue; }
      add('off post');
      const h = hook.get(i) || {};
      let cat;
      if (!v.tk.arrived) cat = v.tk.cause;
      else cat = `left post after arriving: ${h.wait ? 'half-line budget wait' : h.branch || 'no army step'}`;
      add(`off: ${cat}`);
      if (v.deadband) add(`off: ${cat} | of which standing in the 2 m lateral deadband`);
      else if (h.wait) add(`off: ${cat} | of which waiting on the half-line budget`);
      else if (v.moved) add(`off: ${cat} | of which moving`);
      else add(`off: ${cat} | of which standing (${h.branch || 'no army step'})`);
    }
    // ---- 3. legs ----
    for (const [i, v] of view) {
      const j = T.partnerOf(i); if (j < i) continue;
      if (!view.has(j)) { const o = legs.get(i); if (o) { add('legs'); add('failed legs'); add('failed: never given a post (a tank of the pair died in the leg)'); legs.delete(i); } roleWas.delete(i); continue; }
      const bi = v.p.bounding, was = roleWas.get(i); roleWas.set(i, bi);
      if (was !== undefined && was !== bi) {
        const o = legs.get(i);
        if (o) {
          add('legs');
          if (!o.arrived) {
            add('failed legs');
            const f = view.get(o.fwd), h = hook.get(o.fwd) || {};
            if (!o.onLineAtStart) add('failed: never given a post (not on the line at the leg start)');
            else if (o.redirect) add(`failed: redirected mid-leg (${o.redirect})`);
            else add(`failed: short when the leg ended | ${f.deadband ? 'standing in the 2 m lateral deadband' : h.wait ? 'waiting on the half-line budget' : f.moved ? 'still travelling' : `standing (${h.branch || 'no army step'})`}`);
          }
        }
        const fwd = bi ? i : j;
        legs.set(i, { fwd, arrived: false, onLineAtStart: view.get(fwd).onLine, x: view.get(fwd).p.x, push: view.get(fwd).p.push, redirect: '' });
      }
      const o = legs.get(i); if (!o) continue;
      const f = view.get(o.fwd);
      if (f.on) o.arrived = true;
      if (!o.arrived && !o.redirect) { if (f.p.x !== o.x) o.redirect = 'scoot'; else if (f.p.push !== o.push) o.redirect = 'push step'; }
    }
  }
}
rmSync(tmp, { recursive: true, force: true });

const all = r['pair tank-ticks'], off = r['off post'];
const pc = (n, d) => (100 * (n || 0) / d).toFixed(1).padStart(5) + '%';
console.log(`core ${CORE}, seeds ${SEEDS.join(',')}, ${TICKS} ticks`);
console.log(`living-pair tank-ticks ${all}: on post ${pc(r['on post'], all)}, off post ${pc(off, all)}   (bar: on post >= 50%)`);
console.log('OFF POST, by the cause of the last post change (share of off-post | share of all living-pair ticks):');
const offKeys = Object.keys(r).filter((k) => k.startsWith('off: ') && !k.includes(' | ')).sort((a, b) => r[b] - r[a]);
for (const k of offKeys) {
  console.log(`  ${String(r[k]).padStart(7)} ${pc(r[k], off)} | ${pc(r[k], all)}  ${k.slice(5)}`);
  for (const s2 of Object.keys(r).filter((x) => x.startsWith(k + ' | ')).sort((a, b) => r[b] - r[a]))
    console.log(`  ${String(r[s2]).padStart(7)} ${pc(r[s2], off)} | ${pc(r[s2], all)}    ${s2.slice(k.length + 3)}`);
}
for (const k of Object.keys(r).filter((x) => x.startsWith('stacked:')).sort((a, b) => r[b] - r[a])) console.log(`  (post changes: ${r[k]} ${k})`);
const legsN = r.legs, failed = r['failed legs'] || 0, died = r['failed: never given a post (a tank of the pair died in the leg)'] || 0;
console.log(`LEGS with both of the pair alive through the leg (the H2 bar): ${legsN - died}, bounding tank arrived ${legsN - failed} = ${pc(legsN - failed, legsN - died)}   (bar: >= 80%)`);
console.log(`all legs ${legsN} incl. ${died} in which a tank died: arrived ${pc(legsN - failed, legsN)}, failed ${failed}`);
for (const k of Object.keys(r).filter((x) => x.startsWith('failed: ')).sort((a, b) => r[b] - r[a]))
  console.log(`  ${String(r[k]).padStart(5)} ${pc(r[k], failed)} of failed | ${pc(r[k], legsN)} of legs  ${k.slice(8)}`);
