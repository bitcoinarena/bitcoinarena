// WAR_TACTICS.md §0 - "If a probe on this table fails, the doctrine is not live, whatever the code says."
//
//     node tools/measure-war.mjs [--core=DIR] [--seeds=1,2,3,4,5] [--ticks=3600]
//
// Every row of both tables (armour, part A; infantry, part B), PASS or FAIL with the number, and exit 1 if any row is
// red. Truck held in its bay with the handbrake on unless a row says otherwise.
//
// MEASURED ON A COPY. The rows need to know what the rules asked a unit to do this tick (its own step, before the
// separation push), which the core does not report. So the core is copied to a temp directory and hooks are patched
// into the COPY at named anchors; the shipped core has no hooks and no globals. A moved anchor stops the tool with the
// anchor's text rather than measuring something else.
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const CORE = arg('core', new URL('..', import.meta.url).pathname);
// --h1why prints the shape of every H1 miss at the end: how far off in x and z, on which side of the hold, and
// whether the tank was the bounding one. Off by default, so the table's own output does not change.
const H1WHY = process.argv.includes('--h1why');
const h1why = [];
const holdWas = new Map();
const holdDrift = [];
// --walkin: from the tick a tank appears to the tick it first stands on a post, and how much of that it spends
// standing still. H1's misses are half walk-ins, so this is the number that says whether the walk is the lever.
const WALKIN = process.argv.includes('--walkin');
const walkOpen = new Map();
const walkDone = [];
const settledHold = new Map();
const settledOff = [];
const holdGap = [];
const SEEDS = arg('seeds', '1,2,3,4,5').split(',').map(Number);
const TICKS = Number(arg('ticks', 3600));

// ---- the instrumented copy ------------------------------------------------------------------------------------
const tmp = mkdtempSync(join(tmpdir(), 'measure-war-'));
cpSync(join(CORE, 'src'), join(tmp, 'src'), { recursive: true });
const patch = (rel, anchor, insert, where = 'after') => {
  const p = join(tmp, 'src', rel); const s = readFileSync(p, 'utf8');
  if (s.split(anchor).length !== 2) { console.error(`measure-war: anchor not found once in ${rel}:\n${anchor}`); process.exit(2); }
  writeFileSync(p, s.replace(anchor, where === 'after' ? anchor + insert : insert + anchor));
};
patch('rules/army.js', '  u.z = clamp(add(u.z, stepZ), -halfZ, halfZ);\n',
  '  if (globalThis.__W) globalThis.__W.unit(index, u, dx, dz, hold, post);\n');
patch('sim.js', '  // Tanks are pushed out of each other BEFORE anything moves, which is where',
  '  if (globalThis.__W) globalThis.__W.beforeSep(s);\n', 'before');
patch('sim.js', '  const groundOf = (x, z) => surfaceAt(st, x, z);\n',
  '  if (globalThis.__W) globalThis.__W.afterSep(s);\n', 'before');
patch('sim.js', '  for (let i = 0; i < UNITS; i++) {\n    const b = unitBase(i);\n    u.x = s[b + U_X];',
  '  if (globalThis.__W) globalThis.__W.halted(halted);\n', 'before');
// THE CORE'S OWN SEAM, hooked out of the copy (measured 2026-09-19): every hold hangs off the seam at the slot, and
// this tool used to re-derive it as frontlineZ(st.tape, x) - a different reader from the core's glided, scrolled,
// windowed one. The two disagreed by a median 1.37 m against a 1.5 m on-post radius, which is most of what H1 was
// reporting. The copy exports the core's own reader instead, so the rows measure the line the rules used.
patch('sim.js', 'export function surfaceAt(st, x, z) {',
  'export function seamOfCore(st, x) { return seamAtX(st, x); }\n\n', 'before');
const url = (rel) => pathToFileURL(join(tmp, 'src', rel)).href;
const { init, step, teleport, groundAt, submitSample, seamOfCore } = await import(url('sim.js'));
const L = await import(url('state.js'));
const T = await import(url('rules/tactics.js'));
const { frontlineZ } = await import(url('rules/frontline.js'));

const ONE = 65536, HX = 130 * ONE, HZ = 85 * ONE, TPS = 65536 / 1092;
const ARMOUR = Array.from({ length: 24 }, (_, k) => k * 4);
const RIFLES = Array.from({ length: 96 }, (_, i) => i).filter((i) => (i & 3) !== 0);
const base = (i) => L.O_UNITS + i * L.U_WORDS;
const wrap = (t) => (((t % 65536) + 98304) % 65536) - 32768;
const r = {};
const add = (k, n = 1) => { r[k] = (r[k] || 0) + n; };
const sideOf = (i) => (((i >> 2) & 1) === 0 ? -1 : 1);
const hk = { pre: new Map(), sep: new Map(), unit: new Map(), halted: null };
globalThis.__W = {
  beforeSep(s) { hk.pre = new Map(ARMOUR.map((i) => [i, [s[base(i)], s[base(i) + 1]]])); },
  afterSep(s) { hk.sep.clear(); for (const [i, q] of hk.pre) hk.sep.set(i, Math.hypot(s[base(i)] - q[0], s[base(i) + 1] - q[1]) / ONE); },
  unit(i, u, dx, dz, hold, post) { hk.unit.set(i, { dx, dz, hold, post, halted: u.halted }); },
  halted(h) { hk.halted = h.map((a) => a.slice()); },
};

for (const seed of SEEDS) {
  const st = init(seed), s = st.i32;
  const alive = (i) => s[base(i) + L.U_STATE] !== 0;
  add('13a seeds'); if (T.slotOrder(s[L.O_TACTICS], -1).join() !== T.slotOrder(s[L.O_TACTICS], 1).join()) add('13a orders differ');
  const lastDir = new Map(), lastFlip = new Map(), prevPost = new Map();
  const w10 = { '-1': 0, '1': 0 };
  const w60 = () => ({ cross: { '-1': 0, '1': 0 }, give: { '-1': 0, '1': 0 }, lost: { '-1': 0, '1': 0 }, full: { '-1': true, '1': true }, contact: { '-1': false, '1': false }, menLost: { '-1': 0, '1': 0 }, menIn: { '-1': 0, '1': 0 } });
  let win = w60();
  const w5 = new Map();                            // squad key -> { halted, moving, allOnPost }
  const aliveBefore = new Map(Array.from({ length: 96 }, (_, i) => [i, alive(i)]));
  const pushHist = [];                             // per tick: squad key -> [pushNear, mean z of men on post]
  const legOpen = new Map(), roleWas = new Map(), pushWas = [], pushDir = []; const stood = new Set();
  const holderWas = [0, 0, 0]; let changedHands = false;
  for (let t = 0; t < TICKS; t++) {
    const pre = new Map(Array.from({ length: 96 }, (_, i) => [i, [s[base(i)], s[base(i) + 1]]]));
    const slotsBefore = Array.from({ length: 12 }, (_, w) => s[L.O_TACTICS + T.TAC_SLOT + w]);
    const scootBefore = Array.from({ length: 12 }, (_, w) => s[L.O_TACTICS + T.TAC_SCOOT + w]);
    hk.unit.clear();
    step(st, 0, 0, 0, ONE, 0);
    const tick = s[L.O_TICK];
    const liveT = ARMOUR.filter(alive), liveM = RIFLES.filter(alive);
    const mvOf = (i) => { const q = pre.get(i); return q ? Math.hypot(s[base(i)] - q[0], s[base(i) + 1] - q[1]) / ONE : 0; };

    // ================= ARMOUR =================
    // ON THE LINE = within 40 m of its post AND not a column. A column (RULED, the owner 2026-09-16 21:20) is a tank that has
    // not yet stood on its post (within 1.5 m, hull-down pick included) since it spawned or respawned.
    for (const i of liveT) {
      if (!aliveBefore.get(i) || mvOf(i) > 5) stood.delete(i);
      const p = T.postOf(s, L.O_TACTICS, i, tick), sd = sideOf(i), line = frontlineZ(st.tape, p.x, HX, HZ) + sd * p.depth;
      let hold = line;
      if (!p.bounding) { let br = -Infinity; for (let c = -2; c <= 2; c++) { const z = line + c * 2 * ONE; const rise = groundAt(st, p.x, z - sd * 6 * ONE) - groundAt(st, p.x, z); if (rise > br) { br = rise; hold = z; } } }
      if (Math.hypot(s[base(i)] - p.x, s[base(i) + 1] - hold) <= 1.5 * ONE) stood.add(i);
    }
    const onLine = (i) => { if (!stood.has(i)) return false; const p = T.postOf(s, L.O_TACTICS, i, tick); const tz = frontlineZ(st.tape, p.x, HX, HZ) + sideOf(i) * p.depth; return Math.abs(s[base(i) + 1] - tz) <= 40 * ONE; };
    for (const i of liveT) {
      let n = 0; for (const j of liveT) if (j !== i && sideOf(j) === sideOf(i) && Math.hypot(s[base(i)] - s[base(j)], s[base(i) + 1] - s[base(j) + 1]) < 12 * ONE) n++;
      add('A1 tank-ticks'); if (n >= 2) add('A1 pile');
    }
    const movingLine = { '-1': 0, '1': 0 }, countLine = { '-1': 0, '1': 0 };
    for (const i of liveT) {
      const u = hk.unit.get(i); if (!u || !aliveBefore.get(i)) continue;
      const mv = mvOf(i); if (mv > 5) continue;                       // a respawn, not a move
      const sd = String(sideOf(i)); const line = onLine(i); const sep = hk.sep.get(i) || 0;
      const own = !(u.dx === 0 && u.dz === 0);
      // A3: the separation push undoes the tank's own step
      if (own && sep > 0.005) add('A3 fights');
      add('A3 tank-ticks');
      if (!own) { add('A2 holding'); if (mv - sep >= 0.02) add('A2 holding moved'); }
      if (line) { countLine[sd]++; if (mv > 0.02) movingLine[sd]++; }
      if (own && sep <= 0.005 && line) {
        const dir = [Math.sign(u.dx), Math.sign(u.dz)], pd = lastDir.get(i);
        if (pd && ((pd[0] && dir[0] && pd[0] !== dir[0]) || (pd[1] && dir[1] && pd[1] !== dir[1]))) {
          add('A2 flips'); const lf = lastFlip.get(i); if (lf !== undefined && tick - lf < 120) add('A2 fidgets'); lastFlip.set(i, tick);
        }
        lastDir.set(i, dir);
      }
      if (!own && line) { add('A7 holding'); if (Math.abs(wrap(s[base(i) + L.U_HEADING] - (sideOf(i) < 0 ? 0 : 32768))) <= 5461) add('A7 facing'); }
      const p = T.postOf(s, L.O_TACTICS, i, tick); const pk = `${p.x},${p.depth}`;
      if (prevPost.has(i) && prevPost.get(i) !== pk) w10[sd]++; prevPost.set(i, pk);
    }
    for (const sd of ['-1', '1']) { add('A4b side-ticks'); if (countLine[sd] && movingLine[sd] > countLine[sd] / 2) add('A4b over half'); }
    for (const i of ARMOUR) { const j = T.partnerOf(i); if (j < i || !alive(i) || !alive(j)) continue;
      const bi = T.isBounding(s, L.O_TACTICS, i, tick), bj = T.isBounding(s, L.O_TACTICS, j, tick); add('A5 pair-ticks');
      if (bi && bj) add('A5 both bounding');
      const pi = T.postOf(s, L.O_TACTICS, i, tick), pj = T.postOf(s, L.O_TACTICS, j, tick);
      if (bi !== bj && Math.abs(Math.abs(pi.depth - pj.depth) - 14 * ONE) > 1) add('A5 gap not 14 m'); }
    for (let w = 0; w < 12; w++) {
      const slot = s[L.O_TACTICS + T.TAC_SLOT + w];
      if (s[L.O_TACTICS + T.TAC_SCOOT + w] === scootBefore[w]) continue;
      if (slot !== slotsBefore[w]) { add('A6 moved'); if (Math.abs(T.slotX(slot) - T.slotX(slotsBefore[w])) !== 27 * ONE) add('A8 not 27 m'); continue; }
      const held = new Set(); for (let v = 0; v < 12; v++) if (v !== w && (v < 6) === (w < 6)) { held.add(slotsBefore[v]); held.add(s[L.O_TACTICS + T.TAC_SLOT + v]); }
      if ([slotsBefore[w] - 1, slotsBefore[w] + 1].some((n) => n >= 0 && n < 7 && !held.has(n))) add('A6 missed'); else add('A6 hemmed');
    }
    for (const sd of [-1, 1]) {
      const ls = liveT.filter((i) => sideOf(i) === sd); if (ls.length < 6) continue;
      // RULED (the owner 2026-09-16): the share of seam-metre samples covered by >= 2, not a tick-union.
      for (let xm = -81; xm <= 81; xm++) { const zx = frontlineZ(st.tape, xm * ONE, HX, HZ); let n = 0;
        for (const i of ls) if (Math.hypot(s[base(i)] - xm * ONE, s[base(i) + 1] - zx) < 46 * ONE) n++;
        add('A9 samples'); if (n < 2) add('A9 gap'); }
    }
    // ================= HOLD IS THE DEFAULT (§0, re-ruled 2026-09-16 20:30) =================
    // On post = within 1.5 m of its hold: slot x, its line, the hull-down pick for an overwatch tank (§4.1).
    // THE CORE'S OWN SEAM (hooked out of the copy above), not a second derivation of it.
    const seamAt = (x) => seamOfCore(st, x), groundOf = (x, z) => groundAt(st, x, z);
    // WARNING, MEASURED 2026-09-19: this hold is NOT the hold the mover used. `seamAt` here is
    // frontlineZ(st.tape, ...) while the core's own seam is the glided, scrolled, windowed reader in sim.js - so the
    // line under both the crest scan and the bounding post is a different line from the rules'. The hook carries the
    // mover's own hold, and against THAT the row reads 53.3% where this reads 31.2%; the two differ by a median
    // 1.40 m against an on-post radius of 1.5 m. Swapping the fresh crest scan for the doctrine's held crest
    // (T.crestHold) did not close it - 27.5% - because the crest is not what differs. The seam is.
    const holdOf = (i) => { const p = T.postOf(s, L.O_TACTICS, i, tick), sd = sideOf(i); const line = seamAt(p.x) + sd * p.depth;
      if (p.bounding) return [p.x, line];
      let best = line, br = -Infinity; for (let c = -2; c <= 2; c++) { const z = line + c * 2 * ONE; const rise = groundOf(p.x, z - sd * 6 * ONE) - groundOf(p.x, z); if (rise > br) { br = rise; best = z; } }
      return [p.x, best]; };
    const onPostNow = (i) => { const [hx, hz] = holdOf(i); return Math.hypot(s[base(i)] - hx, s[base(i) + 1] - hz) <= 1.5 * ONE; };
    if (WALKIN) for (const i of liveT) {
      const on = onPostNow(i), uu = hk.unit.get(i);
      let w = walkOpen.get(i);
      if (!aliveBefore.get(i) || (mvOf(i) > 5)) { w = { from: tick, ticks: 0, standing: 0 }; walkOpen.set(i, w); }
      if (!w) { if (!on) { w = { from: tick, ticks: 0, standing: 0 }; walkOpen.set(i, w); } else continue; }
      if (on) { walkDone.push({ took: tick - w.from, ticks: w.ticks, standing: w.standing }); walkOpen.delete(i); continue; }
      w.ticks++; if (uu && uu.dx === 0 && uu.dz === 0) w.standing++;
    }
    for (const i of liveT) { const j = T.partnerOf(i); if (j < 0 || !alive(j)) continue; add('H1 pair tank-ticks');
      // SETTLED vs WALKING IN: a tank that has stood on a post since it spawned (bit 7 of U_COOLDOWN) is holding the
      // line; one that has not is still arriving. The row counts both, so this says which of the two it is failing on.
      const settled = ((s[base(i) + L.U_COOLDOWN] >> 7) & 1) === 1;
      if (settled) add('H1 settled tank-ticks'); else add('H1 column tank-ticks');
      // THE ROW'S HOLD AGAINST THE MOVER'S OWN. This probe recomputes the hull-down crest fresh every tick; the core
      // HOLDS a crest (tactics.js hysteresis, §4.1) and only switches for 0.3 m more rise. Where the two differ, H1
      // is asking the tank to stand somewhere the rules never sent it. The hook carries the mover's own hold.
      { const uh = hk.unit.get(i); if (uh && uh.hold !== undefined) {
          const [, hzRow] = holdOf(i);
          holdGap.push(Math.abs(hzRow - uh.hold) / ONE);
          add('H1 hold compared');
          if (Math.hypot(s[base(i)] - T.postOf(s, L.O_TACTICS, i, tick).x, s[base(i) + 1] - uh.hold) <= 1.5 * ONE)
            add('H1 on the mover own hold');
        } }
      // EARLY vs LATE: every tank is a column in the opening drive, so a short run reads as a force permanently
      // walking in. The last third of the run says what the steady state is.
      if (tick >= TICKS - Math.floor(TICKS / 3)) { add('H1 late tank-ticks'); if (settled) add('H1 late settled'); if (settled && onPostNow(i)) add('H1 late settled on post'); }
      if (onPostNow(i)) { add('H1 on post'); if (settled) add('H1 settled on post'); }
      else if (settled) {
        // A SETTLED TANK OFF ITS POST is the gap this row really has: by role, and whether its hold moved under it
        // since the last tick. An overwatch tank should simply be standing on its crest.
        const bd = T.postOf(s, L.O_TACTICS, i, tick).bounding;
        add(bd ? 'H1 settled bounding off' : 'H1 settled overwatch off');
        const [hx2, hz2] = holdOf(i); const was2 = settledHold.get(i); settledHold.set(i, hz2);
        if (was2 !== undefined && Math.abs(hz2 - was2) > ONE / 2) add(bd ? 'H1 hold jumped bounding' : 'H1 hold jumped overwatch');
        // HOW FAR IT STILL HAS TO GO, and whether it holds a budget grant (bit 6 of U_COOLDOWN). A tank two metres
        // out with no grant is a tank the half-line budget is holding, not one that cannot drive.
        // WHAT THE RULES HELD IT WITH: the hook carries the unit's own step, its hold, its post and whether it was
        // HALTED this tick - and only those. Asking that record for `crowded` or `tacWait` returns undefined, which
        // reads as a tidy 0% and means nothing; this probe printed exactly that once before it was caught.
        const u2 = hk.unit.get(i);
        settledOff.push({ far: Math.hypot(s[base(i)] - hx2, s[base(i) + 1] - hz2) / ONE,
                          granted: ((s[base(i) + L.U_COOLDOWN] >> 6) & 1) === 1,
                          halted: !!(u2 && u2.halted),
                          still: !!(u2 && u2.dx === 0 && u2.dz === 0) });
      } else if (settled) settledHold.set(i, holdOf(i)[1]);
      // WHY A TANK IS NOT ON ITS HOLD: the row says 25% and nothing about the miss. This splits it into the two axes
      // and says whether the tank is short of its hold or past it, so a lane still walking in is not confused with
      // one that oscillates on the spot.
      else if (H1WHY) { const [hx, hz] = holdOf(i); const dx = (s[base(i)] - hx) / ONE, dz = (s[base(i) + 1] - hz) / ONE;
        // AND WHETHER IT WAS EVEN TRYING: the rules' own step for this tick, before the separation push. A tank
        // standing still 11 m short of its hold is a different fault from one walking toward it.
        const uu = hk.unit.get(i);
        // HOW FAST THE HOLD ITSELF MOVES. The post is the seam at the slot plus a depth, and the seam scrolls with the
        // tape - so a tank that stands perfectly still drifts off its own post. If that drift is quick, "hold is the
        // default" and "no more than half the line moving" cannot both be met, and that is a ruling, not a bug.
        const wasHold = holdWas.get(i); holdWas.set(i, hz);
        if (wasHold !== undefined) holdDrift.push(Math.abs(hz - wasHold) / ONE);
        h1why.push({ dx: Math.round(dx * 10) / 10, dz: Math.round(dz * 10) / 10, shortOf: sideOf(i) * dz > 0,
                     bounding: T.postOf(s, L.O_TACTICS, i, tick).bounding,
                     still: !!(uu && uu.dx === 0 && uu.dz === 0),
                     // A COLUMN: bit 7 of the tank's U_COOLDOWN word - it has not yet stood on its post since it
                     // spawned or respawned. A force whose misses are mostly columns is a force still walking in.
                     column: ((s[base(i) + L.U_COOLDOWN] >> 7) & 1) === 0,
                     towards: !!(uu && Math.sign(uu.dz) === -Math.sign(dz)) }); } }
    for (const i of liveT) { const j = T.partnerOf(i); if (j < i || !alive(j)) { legOpen.delete(i); roleWas.delete(i); continue; }
      const bi = T.isBounding(s, L.O_TACTICS, i, tick), was = roleWas.get(i); roleWas.set(i, bi);
      if (was !== undefined && was !== bi) { const o = legOpen.get(i); if (o) { add('H2 legs'); if (o.arrived) add('H2 arrived'); } legOpen.set(i, { fwd: bi ? i : j, arrived: false }); }
      const o = legOpen.get(i); if (o && !o.arrived && onPostNow(o.fwd)) o.arrived = true; }
    for (let w = 0; w < 12; w++) { const pu = s[L.O_TACTICS + T.TAC_PUSH + w];
      if (pushWas[w] !== undefined && pu !== pushWas[w]) { const d = Math.sign(pu - pushWas[w]); add('H3 push steps'); if (pushDir[w] && pushDir[w] !== d) add('H3 push reversals'); pushDir[w] = d; }
      pushWas[w] = pu; }

    // ================= LOSSES BITE (§3 supply, §0.1) =================
    {
      const held = { '-1': 0, '1': 0 };
      for (let o = 0; o < 3; o++) { const hh = T.objectiveHolder(s, L.O_TACTICS, o); if (hh === T.HOLDER_BULL) held['-1']++; else if (hh === T.HOLDER_BEAR) held['1']++; }
      const tanks = { '-1': liveT.filter((i) => sideOf(i) === -1).length, '1': liveT.filter((i) => sideOf(i) === 1).length };
      if (held['-1'] !== held['1']) { const more = held['-1'] > held['1'] ? '-1' : '1', less = more === '-1' ? '1' : '-1'; add('S1 uneven ticks'); if (tanks[more] > tanks[less]) add('S1 more tanks'); }
      for (const sd of ['-1', '1']) { const other = sd === '-1' ? '1' : '-1'; if (held[other] >= 2) { add('S2 down two'); if (tanks[sd] < 4) add('S2 below 4'); } }
    }

    // ================= OBJECTIVES (§4.11) =================
    const lanes = [0, 1, 2].map((o) => T.objectiveLane(s, L.O_TACTICS, o));
    for (let w = 0; w < 12; w++) {
      const pu = s[L.O_TACTICS + T.TAC_PUSH + w] / ONE, on = lanes.includes(s[L.O_TACTICS + T.TAC_SLOT + w]);
      if (pu >= 16) { add('O1 pushed team-ticks'); if (on) add('O1 pushed on a lane'); }
      add(on ? 'O1 on n' : 'O1 off n'); add(on ? 'O1 on push' : 'O1 off push', pu);
    }
    for (let o = 0; o < 3; o++) {
      const px = T.slotX(lanes[o]), pz = frontlineZ(st.tape, px, HX, HZ);
      const near = (sd) => liveT.some((i) => sideOf(i) === sd && Math.hypot(s[base(i)] - px, s[base(i) + 1] - pz) < 46 * ONE);
      add(`O2 ticks ${o}`); if (near(-1) && near(1)) add(`O2 fought ${o}`);
      const h = T.objectiveHolder(s, L.O_TACTICS, o);
      if (h !== 0) { if (holderWas[o] !== 0 && holderWas[o] !== h) changedHands = true; holderWas[o] = h; }
    }
    const push = { '-1': [], '1': [] };
    for (let w = 0; w < 12; w++) { const sd = w < 6 ? '-1' : '1'; const p = s[L.O_TACTICS + T.TAC_PUSH + w] / ONE; push[sd].push(p); if (p < 0) win.give[sd]++; add('A11c team-ticks'); if (p !== 0) add('A11c off default'); }
    for (const i of liveT) { const p = T.postOf(s, L.O_TACTICS, i, tick); if ((s[base(i) + 1] - frontlineZ(st.tape, p.x, HX, HZ)) * sideOf(i) < 0) win.cross[String(sideOf(i))]++; }
    const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    add('A13b ticks'); if (Math.abs(mean(push['-1']) - mean(push['1'])) >= 4) add('A13b differ');
    for (const sd of [-1, 1]) {
      const n = liveT.filter((i) => sideOf(i) === sd).length; add('A12b side-ticks'); if (n < 4) add('A12b below 4');
      if (n < 12) win.full[sd] = false;
      for (const i of ARMOUR) if (sideOf(i) === sd && aliveBefore.get(i) && !alive(i)) win.lost[sd]++;
      if (liveT.some((i) => sideOf(i) === -sd && liveT.some((j) => sideOf(j) === sd && Math.hypot(s[base(i)] - s[base(j)], s[base(i) + 1] - s[base(j) + 1]) < 46 * ONE))) win.contact[sd] = true;
    }

    // ================= INFANTRY =================
    const teamOfM = (i) => T.rifleTeamOf(i);
    const byTeam = new Map();
    for (const i of liveM) { const k = `${sideOf(i)}:${teamOfM(i).team}`; if (!byTeam.has(k)) byTeam.set(k, []); byTeam.get(k).push(i); }
    for (const i of liveM) {
      add('B1 man-ticks');
      const mates = byTeam.get(`${sideOf(i)}:${teamOfM(i).team}`).filter((j) => j !== i);
      if (mates.some((j) => Math.hypot(s[base(i)] - s[base(j)], s[base(i) + 1] - s[base(j) + 1]) < 18 * ONE)) add('B1 near a mate');
      // B5 hull clearance
      add('B5 man-ticks'); if (liveT.some((j) => Math.hypot(s[base(i)] - s[base(j)], s[base(i) + 1] - s[base(j) + 1]) < 3 * ONE - 1)) add('B5 inside a hull');
    }
    for (const [, men] of byTeam) {
      const old = men.filter((i) => aliveBefore.get(i) && mvOf(i) < 5); if (old.length < 2) continue;
      const moving = old.map((i) => mvOf(i) > 0.02); add('B1b team-ticks');
      if (moving.every(Boolean) || moving.every((m) => !m)) add('B1b together');
    }
    // B2: per squad, a 5 s window. A man's squad is his FIRE TEAM's: the squad drawn for its first man (§9.2, RULED
    // the owner 2026-09-16), which is the anchor he stands on - not the squad drawn at his own spawn.
    const squadOf = (i) => { const ft = T.rifleTeamOf(i); return s[base(T.firstManOf(ft.side, ft.team)) + L.U_TARGET]; };
    for (const i of liveM) { const k = `${sideOf(i)}:${squadOf(i)}`; const w = w5.get(k) || { halted: false, moving: false, allOnPost: true };
      const u = hk.unit.get(i); if (u) { if (u.halted) w.halted = true; if (mvOf(i) > 0.02 && mvOf(i) < 5) w.moving = true; if (!(u.dx === 0 && u.dz === 0)) w.allOnPost = false; } w5.set(k, w); }
    if ((t + 1) % 300 === 0) { for (const [, w] of w5) { add('B2 squad-windows'); if (!w.halted || (!w.allOnPost && !w.moving)) add('B2 fail'); } w5.clear(); }
    // B3 spread of men on post, per side
    for (const sd of [-1, 1]) {
      const on = liveM.filter((i) => sideOf(i) === sd && hk.unit.get(i) && hk.unit.get(i).dx === 0 && hk.unit.get(i).dz === 0);
      if (on.length < 6) continue;
      const zs = on.map((i) => (s[base(i) + 1] - frontlineZ(st.tape, s[base(i)], HX, HZ)) / ONE), xs = on.map((i) => s[base(i)] / ONE);
      const sdev = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) * (v - m)))); };
      add('B3 side-ticks'); const zsd = sdev(zs), xsd = sdev(xs);
      if (zsd < 4 || zsd > 12) add('B3 z out'); if (xsd < 20 || xsd > 60) add('B3 x out');
    }
    // B4 follow the push: squad pushNear and mean z (relative to seam) of its men on post
    const squadNow = new Map();
    for (const i of liveM) { const u = hk.unit.get(i); if (!u || u.dx !== 0 || u.dz !== 0) continue;
      const sd = sideOf(i), sq = squadOf(i), k = `${sd}:${sq}`;
      const anchor = s[L.O_SQUADS + (sd < 0 ? 0 : L.SQUADS_PER_SIDE) + sq];
      const e = squadNow.get(k) || { push: T.pushNear(s, L.O_TACTICS, sd, anchor), z: [] };
      e.z.push((s[base(i) + 1] - frontlineZ(st.tape, s[base(i)], HX, HZ)) * -sd / ONE); squadNow.set(k, e); }
    pushHist.push(squadNow);
    // B6 losses and arrivals of men
    for (const i of RIFLES) { const sd = String(sideOf(i)); if (aliveBefore.get(i) && !alive(i)) win.menLost[sd]++;
      if (!aliveBefore.get(i) && alive(i)) { win.menIn[sd]++; add('B6 arrivals'); if (Math.abs(s[base(i) + 1]) < 60 * ONE) add('B6 appeared on the line'); } }

    for (let i = 0; i < 96; i++) aliveBefore.set(i, alive(i));
    if ((t + 1) % 600 === 0) { for (const sd of ['-1', '1']) { add('A4a windows'); if (w10[sd] === 0) add('A4a still'); w10[sd] = 0; } }
    if ((t + 1) % 3600 === 0) {
      for (const sd of ['-1', '1']) {
        add('A11 windows'); if (win.cross[sd] === 0) add('A11a no crossing'); if (win.give[sd] === 0) add('A11b no giving');
        if (win.full[sd] && win.lost[sd] === 0 && win.contact[sd]) add('A12a full lossless');
        add('B6 windows'); if (win.menLost[sd] < 3 || win.menIn[sd] < 3) add('B6 fail');
      }
      win = w60();
    }
  }
  add('O3 seeds'); if (changedHands) add('O3 changed hands');
  // B4: whenever a squad's pushNear changes by 8 m or more, the mean on-post z of its men moves at least half of it the
  // same way within 600 ticks.
  for (let t = 1; t < pushHist.length; t++) for (const [k, e] of pushHist[t]) {
    const prev = pushHist[t - 1].get(k); if (!prev || prev.push === e.push || !prev.z.length) continue;
    const want = (e.push - prev.push) / ONE; const z0 = mean(prev.z); add('B4 changes');
    let ok = false; for (let u = t; u < Math.min(pushHist.length, t + 600); u++) { const f = pushHist[u].get(k); if (f && f.z.length && (mean(f.z) - z0) * Math.sign(want) >= Math.abs(want) / 2) { ok = true; break; } }
    if (!ok) add('B4 did not follow');
  }
}
function mean(a) { return a.reduce((x, y) => x + y, 0) / a.length; }

// Rows 10 (A) and 7 (B): posts with the truck parked vs driven through the line, same seed, until the worlds differ.
{
  let diff = 0, compared = 0, objDiff = 0, objCompared = 0;
  for (const seed of SEEDS) {
    const a = init(seed), b = init(seed);
    const postsA = new Map(), postsB = new Map();
    let lanesOnly = false;
    for (let t = 0; t < TICKS; t++) {
      hk.unit.clear(); step(a, 0, 0, 0, ONE, ONE); for (const [i, u] of hk.unit) postsA.set(i, [u.hold, u.post]);
      teleport(b, Math.round((-80 + 160 * t / TICKS) * ONE), 0, 16384);
      hk.unit.clear(); step(b, 0, 0, 0, ONE, ONE); for (const [i, u] of hk.unit) postsB.set(i, [u.hold, u.post]);
      // The same fight only while nothing the truck did has touched it: a shot at the truck draws from the stream (and a
      // team scoots after it, §4.3); a man run over or cleared out of the way moves. From then on the worlds differ.
      let same = true;
      for (let k = 0; k < L.RNG_WORDS; k++) if (a.i32[L.O_RNG + k] !== b.i32[L.O_RNG + k]) same = false;
      for (let i = 0; i < 96; i++) if (a.i32[base(i) + L.U_HP] !== b.i32[base(i) + L.U_HP] || a.i32[base(i) + L.U_STATE] !== b.i32[base(i) + L.U_STATE]
        || a.i32[base(i)] !== b.i32[base(i)] || a.i32[base(i) + 1] !== b.i32[base(i) + 1]) same = false;
      for (let o = 0; o < 3; o++) { objCompared++; if (T.objectiveLane(a.i32, L.O_TACTICS, o) !== T.objectiveLane(b.i32, L.O_TACTICS, o)) objDiff++; }
      if (!same) { lanesOnly = true; continue; }
      for (let o = 0; o < 3; o++) { objCompared++; if (a.i32[L.O_TACTICS + T.TAC_OBJ + o] !== b.i32[L.O_TACTICS + T.TAC_OBJ + o]) objDiff++; }
      if (lanesOnly) continue;
      for (const [i, pa] of postsA) { const pb = postsB.get(i); if (!pb) continue; compared++; if (pa[0] !== pb[0] || pa[1] !== pb[1]) diff++; }
    }
  }
  r['X10 compared'] = compared; r['X10 differ'] = diff; r['O5 compared'] = objCompared; r['O5 differ'] = objDiff;
}

// Row "the chart is the market's alone" (§4.14): lead, trend and momentum bit-identical with the truck parked and the truck
// driven through the line, and across two players' runs (two seeds) on the same samples. The tape is driven as the trend
// probe does (+0.5% over twelve samples, then down again). `front` (the round's verdict) is not a core word yet.
{
  let compared = 0, diff = 0, across = 0, acrossDiff = 0;
  const market = (st) => [0, 1, 2, 3, 4, 5].map((k) => st.i32[L.O_TACTICS + T.TAC_MARKET + k]).join(',');
  for (const seed of SEEDS) {
    const a = init(seed), b = init(seed), c = init(seed + 1000);
    const open = a.tape[a.tape.length - 1];
    let price = open;
    for (let t = 0; t < TICKS; t++) {
      if (t >= 600 && t < 1800 && (t - 600) % 50 === 0) {
        price += (t < 1200 ? 1 : -1) * Math.round(open * 0.005 / 12);
        submitSample(a, price); submitSample(b, price); submitSample(c, price);
      }
      step(a, 0, 0, 0, ONE, ONE);
      teleport(b, Math.round((-80 + 160 * t / TICKS) * ONE), 0, 16384);
      step(b, 0, 0, 0, ONE, ONE);
      step(c, 0, 0, 0, ONE, ONE);
      compared++; if (market(a) !== market(b)) diff++;
      across++; if (market(a) !== market(c)) acrossDiff++;
    }
  }
  r['M1 compared'] = compared; r['M1 differ'] = diff; r['M1 across'] = across; r['M1 across differ'] = acrossDiff;
}

rmSync(tmp, { recursive: true, force: true });
const pct = (a, b) => (r[b] ? (r[a] || 0) / r[b] : 0);
const P = (x) => (100 * x).toFixed(2) + '%';
const rows = [
  ['A1  pile: 3 tanks within 12 m', P(pct('A1 pile', 'A1 tank-ticks')), pct('A1 pile', 'A1 tank-ticks') <= 0.02],
  ['A2  holding tank moved >= 0.02 m of its own', P(pct('A2 holding moved', 'A2 holding')), (r['A2 holding moved'] || 0) === 0],
  ['A2  fidgets (2nd flip inside 2 s) of all flips', `${r['A2 fidgets'] || 0} of ${r['A2 flips'] || 0} = ${P(pct('A2 fidgets', 'A2 flips'))}`, pct('A2 fidgets', 'A2 flips') < 0.02],
  ['A3  separation undoes a tank\'s own step', P(pct('A3 fights', 'A3 tank-ticks')), pct('A3 fights', 'A3 tank-ticks') < 0.05],
  ['A4a 10 s windows with no post change on a side', `${r['A4a still'] || 0} of ${r['A4a windows']}`, (r['A4a still'] || 0) === 0],
  ['A4b ticks with > half the line moving', P(pct('A4b over half', 'A4b side-ticks')), pct('A4b over half', 'A4b side-ticks') <= 0.02],
  ['A5  both of a pair bounding / gap not 14 m', `${r['A5 both bounding'] || 0} / ${r['A5 gap not 14 m'] || 0}`, !(r['A5 both bounding'] || r['A5 gap not 14 m'])],
  ['A6  scoot missed with a free slot beside', `${r['A6 missed'] || 0} (moved ${r['A6 moved'] || 0}, hemmed ${r['A6 hemmed'] || 0})`, (r['A6 missed'] || 0) === 0],
  ['A7  holding hulls on the line facing the enemy', P(pct('A7 facing', 'A7 holding')), pct('A7 facing', 'A7 holding') > 0.95],
  ['A8  slot changes not exactly 27 m', `${r['A8 not 27 m'] || 0}`, (r['A8 not 27 m'] || 0) === 0],
  ['A9  seam-metre samples covered by < 2', P(pct('A9 gap', 'A9 samples')), pct('A9 gap', 'A9 samples') <= 0.05],
  ['A10 posts differing with the truck parked vs driven', `${r['X10 differ']} of ${r['X10 compared']}`, r['X10 differ'] === 0],
  ['A11a 60 s windows with no team across the seam', `${r['A11a no crossing'] || 0} of ${r['A11 windows']}`, (r['A11a no crossing'] || 0) === 0],
  ['A11b 60 s windows with no team giving ground', `${r['A11b no giving'] || 0} of ${r['A11 windows']}`, (r['A11b no giving'] || 0) === 0],
  ['A11c team-ticks off the 16 m default', P(pct('A11c off default', 'A11c team-ticks')), pct('A11c off default', 'A11c team-ticks') > 0.3],
  ['A12a side full and lossless 60 s in contact', `${r['A12a full lossless'] || 0}`, (r['A12a full lossless'] || 0) === 0],
  ['A12b side below 4 tanks', P(pct('A12b below 4', 'A12b side-ticks')), pct('A12b below 4', 'A12b side-ticks') <= 0.05],
  ['A13a slot orders differ', `${r['13a orders differ'] || 0} of ${r['13a seeds']}`, r['13a orders differ'] === r['13a seeds']],
  ['A13b sides\' mean push differs >= 4 m', P(pct('A13b differ', 'A13b ticks')), pct('A13b differ', 'A13b ticks') > 0.5],
  ['H1  pair tank-ticks within 1.5 m of the hold', P(pct('H1 on post', 'H1 pair tank-ticks')), pct('H1 on post', 'H1 pair tank-ticks') >= 0.5],
  ['H2  legs whose new bounding tank reached its post', `${r['H2 arrived'] || 0} of ${r['H2 legs'] || 0} = ${P(pct('H2 arrived', 'H2 legs'))}`, pct('H2 arrived', 'H2 legs') >= 0.8],
  ['H3  push steps reversing the previous (information)', `${r['H3 push reversals'] || 0} of ${r['H3 push steps'] || 0} = ${P(pct('H3 push reversals', 'H3 push steps'))}, ${((r['H3 push steps'] || 0) / (SEEDS.length * 12 * TICKS / 3600)).toFixed(2)} steps per team-minute`, true],
  ['O1  pushed >= 16 team-ticks on an objective lane', P(pct('O1 pushed on a lane', 'O1 pushed team-ticks')), pct('O1 pushed on a lane', 'O1 pushed team-ticks') >= 0.6],
  ['O1  mean push on objective lanes minus the rest', `${(r['O1 on push'] / r['O1 on n'] - r['O1 off push'] / r['O1 off n']).toFixed(2)} m`, r['O1 on push'] / r['O1 on n'] - r['O1 off push'] / r['O1 off n'] >= 6],
  ['O2  ticks with both sides inside 46 m (RIDGE/HOLLOW/GAP)', [0, 1, 2].map((o) => P(pct(`O2 fought ${o}`, `O2 ticks ${o}`))).join(' / '), [0, 1, 2].every((o) => pct(`O2 fought ${o}`, `O2 ticks ${o}`) >= 0.6)],
  ['O3  seeds on which an objective changed hands', `${r['O3 changed hands'] || 0} of ${r['O3 seeds']}`, (r['O3 changed hands'] || 0) >= 4],
  ['O4  client draws the markers (client test, not this probe)', 'not built', false],
  ['O5  objective words differing, truck parked vs driven', `${r['O5 differ']} of ${r['O5 compared']}`, r['O5 differ'] === 0],
  ['M1  lead/trend/momentum differing, truck parked vs driven', `${r['M1 differ']} of ${r['M1 compared']}`, r['M1 differ'] === 0],
  ['M1  lead/trend/momentum differing, two players (seeds) on the same samples', `${r['M1 across differ']} of ${r['M1 across']}`, r['M1 across differ'] === 0],
  ['S1  side holding more objectives has more living tanks', P(pct('S1 more tanks', 'S1 uneven ticks')), pct('S1 more tanks', 'S1 uneven ticks') >= 0.55],
  ['S2  side with 2+ objectives lost below 4 tanks', P(pct('S2 below 4', 'S2 down two')), pct('S2 below 4', 'S2 down two') <= 0.08],
  ['B1  man within 18 m of a fire-team mate', P(pct('B1 near a mate', 'B1 man-ticks')), pct('B1 near a mate', 'B1 man-ticks') > 0.8],
  ['B1  fire team moves or halts together', P(pct('B1b together', 'B1b team-ticks')), pct('B1b together', 'B1b team-ticks') > 0.9],
  ['B2  5 s squad windows without a halted team / a mover', `${r['B2 fail'] || 0} of ${r['B2 squad-windows']}`, (r['B2 fail'] || 0) === 0],
  ['B3  side-ticks with men-on-post spread out of band', `z ${P(pct('B3 z out', 'B3 side-ticks'))}, x ${P(pct('B3 x out', 'B3 side-ticks'))}`, !(r['B3 z out'] || r['B3 x out'])],
  ['B4  push changes the squad did not follow in 10 s', `${r['B4 did not follow'] || 0} of ${r['B4 changes'] || 0}`, (r['B4 did not follow'] || 0) === 0],
  ['B5  man-ticks inside 3 m of a tank', P(pct('B5 inside a hull', 'B5 man-ticks')), pct('B5 inside a hull', 'B5 man-ticks') <= 0.005],
  ['B6  60 s windows with < 3 men lost or arrived / arrivals on the line', `${r['B6 fail'] || 0} of ${r['B6 windows']} / ${r['B6 appeared on the line'] || 0} of ${r['B6 arrivals'] || 0}`, !(r['B6 fail'] || r['B6 appeared on the line'])],
];
let red = 0;
for (const [name, got, ok] of rows) { if (!ok) red++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(58)} ${got}`); }
{
  const settled = r['H1 settled tank-ticks'] || 0, onSettled = r['H1 settled on post'] || 0, col = r['H1 column tank-ticks'] || 0;
  const bo = r['H1 settled bounding off'] || 0, oo = r['H1 settled overwatch off'] || 0;
  const bj = r['H1 hold jumped bounding'] || 0, oj = r['H1 hold jumped overwatch'] || 0;
  if (settledOff.length) {
    const a = settledOff.map((x) => x.far).sort((p, q2) => p - q2);
    const near = settledOff.filter((x) => x.far <= 4);
    console.log(`settled off post: ${settledOff.length} ticks, distance q1/med/q3 `
      + `${a[Math.floor(a.length / 4)].toFixed(1)} / ${a[Math.floor(a.length / 2)].toFixed(1)} / ${a[Math.floor(a.length * 3 / 4)].toFixed(1)} m; `
      + `within 4 m of the hold ${(100 * near.length / settledOff.length).toFixed(0)}%, and of those `
      + `${(100 * near.filter((x) => x.granted).length / Math.max(near.length, 1)).toFixed(0)}% held a budget grant`);
    const sh = (k) => (100 * settledOff.filter((x) => x[k]).length / settledOff.length).toFixed(0) + '%';
    console.log(`settled off post, what the rules held: halted ${sh('halted')}, standing still ${sh('still')}, `
      + `holding a budget grant ${sh('granted')}`);
  }
  if (bo + oo > 0)
    console.log(`settled and off post: bounding ${bo} (hold jumped under it on ${(100 * bj / Math.max(bo, 1)).toFixed(1)}% of them), `
      + `overwatch ${oo} (hold jumped on ${(100 * oj / Math.max(oo, 1)).toFixed(1)}%)`);
  if (holdGap.length) {
    const g = holdGap.slice().sort((a, b) => a - b);
    console.log(`the row's hold against the mover's own: median ${g[Math.floor(g.length / 2)].toFixed(2)} m, `
      + `q3 ${g[Math.floor(g.length * 3 / 4)].toFixed(2)} m, max ${g[g.length - 1].toFixed(2)} m; `
      + `measured against the MOVER'S hold, on post ${(100 * (r['H1 on the mover own hold'] || 0) / Math.max(r['H1 hold compared'] || 1, 1)).toFixed(1)}%`);
  }
  const lateAll = r['H1 late tank-ticks'] || 0, lateSet = r['H1 late settled'] || 0, lateOn = r['H1 late settled on post'] || 0;
  if (lateAll > 0)
    console.log(`last third of the run: ${(100 * lateSet / lateAll).toFixed(0)}% of pair tank-ticks are settled, `
      + `and ${(100 * lateOn / Math.max(lateSet, 1)).toFixed(1)}% of those are on post `
      + `(overall ${(100 * lateOn / lateAll).toFixed(1)}%)`);
  if (settled + col > 0)
    console.log(`H1 split: settled tank-ticks ${settled} of ${settled + col} (${(100 * settled / (settled + col)).toFixed(0)}%), `
      + `of which on post ${(100 * onSettled / Math.max(settled, 1)).toFixed(1)}%; walking in ${col} `
      + `(${(100 * col / (settled + col)).toFixed(0)}%), none of which can be on post by definition`);
}
if (WALKIN) {
  const q = (xs) => { const a = xs.slice().sort((p, r) => p - r); return a.length ? [a[0], a[Math.floor(a.length / 4)], a[Math.floor(a.length / 2)], a[Math.floor(a.length * 3 / 4)], a[a.length - 1]] : [0, 0, 0, 0, 0]; };
  const secs = walkDone.map((w) => w.took / 60);
  const standShare = walkDone.filter((w) => w.ticks > 0).map((w) => w.standing / w.ticks);
  console.log(`walk-ins that reached a post: ${walkDone.length}; seconds min/q1/med/q3/max `
    + `${q(secs).map((v) => v.toFixed(1)).join(' / ')}; share of those ticks standing still `
    + `${q(standShare).map((v) => (100 * v).toFixed(0) + '%').join(' / ')}; still walking at the end: ${walkOpen.size}`);
}
if (H1WHY && h1why.length) {
  const q = (xs) => { const a = xs.slice().sort((p, r) => p - r); return [a[0], a[Math.floor(a.length / 4)], a[Math.floor(a.length / 2)], a[Math.floor(a.length * 3 / 4)], a[a.length - 1]]; };
  const dzs = h1why.map((r) => Math.abs(r.dz)), dxs = h1why.map((r) => Math.abs(r.dx));
  const shortOf = h1why.filter((r) => r.shortOf).length, bounding = h1why.filter((r) => r.bounding).length;
  const still = h1why.filter((r) => r.still).length, towards = h1why.filter((r) => r.towards).length;
  if (holdDrift.length) {
    const d = holdDrift.slice().sort((a, b) => a - b);
    const per = (v) => (v * 60).toFixed(2);
    console.log(`the hold itself moves, per tick: median ${d[Math.floor(d.length / 2)].toFixed(3)} m `
      + `(${per(d[Math.floor(d.length / 2)])} m/s), q3 ${d[Math.floor(d.length * 3 / 4)].toFixed(3)} m, `
      + `max ${d[d.length - 1].toFixed(2)} m; samples ${d.length}`);
  }
  console.log(`H1 misses: ${h1why.length}; |dz| min/q1/med/q3/max ${q(dzs).map((v) => v.toFixed(1)).join(' / ')} m; `
    + `|dx| ${q(dxs).map((v) => v.toFixed(1)).join(' / ')} m; short of the hold ${(100 * shortOf / h1why.length).toFixed(0)}%; `
    + `bounding ${(100 * bounding / h1why.length).toFixed(0)}%; standing still ${(100 * still / h1why.length).toFixed(0)}%; `
    + `stepping toward the hold ${(100 * towards / h1why.length).toFixed(0)}%; `
    + `never yet stood on a post ${(100 * h1why.filter((r) => r.column).length / h1why.length).toFixed(0)}%`);
}
console.log(`${rows.length - red} of ${rows.length} rows pass (seeds ${SEEDS.join(',')}, ${TICKS} ticks)`);
process.exit(red ? 1 : 0);
