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
const VERDICTS = process.argv.includes('--verdicts');
const verdictCount = {};
const verdictWas = {};
const pushSeen = [];
const pushWasV = {};
const pushMoves = [];
const A9WHY = process.argv.includes('--a9why');
const a9gap = {}, a9all = {}, a9live = [], a9near = [];
const a9x = [[], []], a9slot = [[], []];
const a9slope = {}, a9slopeN = {};
const B3WHY = process.argv.includes('--b3why');
const CAUSE = process.argv.includes('--cause');
const SHARE = process.argv.includes('--share');
const b3OutNow = new Map();
const haltSuppressedNow = new Set();
const winSteps = { give: {}, take: {} };
const objLaneWas = new Map();
const holdBefore = new Map(), holdBeforeNext = new Map();
const branchNow = new Map();
let pushWrittenMin = Infinity, pushWrittenMax = -Infinity, pushSeenMin = Infinity, pushSeenMax = -Infinity;
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
// WHICH BRANCH SET THE Z STEP (2026-09-19, A2): a tank that reverses beside a stationary hold is oscillating, and the
// three branches - give ground, hold after giving, walk to the post - want different answers. Named, not guessed.
patch('rules/army.js', '    gaveGround = 1;\n', '    if (globalThis.__W) globalThis.__W.branch(index, "backoff");\n');
patch('rules/army.js', '    // ONLY A TANK THAT GAVE GROUND (bit 5 of its memory word, cleared once no enemy is inside 30 m). Read as "any tank',
  '    if (globalThis.__W) globalThis.__W.branch(index, "heldAfterGiving");\n', 'before');
patch('rules/army.js', '    const want = !crossing && abs(gap) > band ? (gap > 0 ? ONE : -ONE) : 0;',
  '\n    if (globalThis.__W) globalThis.__W.branch(index, crossing ? "crossing" : (want === 0 ? "inBand" : (arrivingZ ? "arriving" : "walking")));');
patch('sim.js', '  // Tanks are pushed out of each other BEFORE anything moves, which is where',
  '  if (globalThis.__W) globalThis.__W.beforeSep(s);\n', 'before');
patch('sim.js', '  const groundOf = (x, z) => surfaceAt(st, x, z);\n',
  '  if (globalThis.__W) globalThis.__W.afterSep(s);\n', 'before');
patch('sim.js', '  for (let i = 0; i < UNITS; i++) {\n    const b = unitBase(i);\n    u.x = s[b + U_X];',
  '  if (globalThis.__W) globalThis.__W.halted(halted);\n', 'before');
// §11.2's suppression, counted: a team whose halt was cancelled because its lower neighbour halted. B2's failures are
// all the halt half, so this says how often the rule itself is what leaves a window with no halted team.
patch('sim.js', '      halted[sd][f] = raw && !(f > 0 && halted[sd][f - 1]);',
  '\n      if (globalThis.__W) globalThis.__W.haltRaw(sd, f, raw, halted[sd][f]);');
// THE PUSH RE-READ ITSELF (§4.10): every team's scheduled tick, whether it was skipped for a tank off post, the
// verdict it read, whether that verdict matched the last one, and the step it took. A11b, A13b and both O1 rows ask
// the push to DO something, so what the re-read does is the one number under all four.
patch('rules/tactics.js', '    if (mod((tick | 0) + mod(mix(hash, 300 + w) >>> 1, PUSH_TICKS), PUSH_TICKS) !== 0) continue;',
  '\n    if (globalThis.__W) globalThis.__W.reread(w, tick);');
patch('rules/tactics.js', '    if (!teamOnPost(s, base, side, team, tick, seamAt, ground)) continue;',
  '\n    if (globalThis.__W) globalThis.__W.onPostOk(w);', 'after');
patch('rules/tactics.js', '    const confirmed = s[base + TAC_VERDICT + w] === verdict;',
  '\n    if (globalThis.__W) globalThis.__W.verdict(w, verdict, s[base + TAC_VERDICT + w], s[base + TAC_PUSH + w], '
  + 'weight, terms.rest, terms.ceiling, own, foe, widow);');
patch('rules/tactics.js', '    s[base + TAC_PUSH + w] = push | 0;',
  '\n    if (globalThis.__W) globalThis.__W.stepped(w, push, verdict);');
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
// THE MAIN PASS ONLY. This tool steps extra worlds for the parked-vs-driven rows, and the push hooks counted those
// too: 1728 re-reads where twelve teams over two seeds can have 288. Anything hooked inside the core must say which
// world it is in.
let mainPass = false;
const r = {};
const add = (k, n = 1) => { r[k] = (r[k] || 0) + n; };
const sideOf = (i) => (((i >> 2) & 1) === 0 ? -1 : 1);
const hk = { pre: new Map(), sep: new Map(), unit: new Map(), halted: null };
globalThis.__W = {
  beforeSep(s) { hk.pre = new Map(ARMOUR.map((i) => [i, [s[base(i)], s[base(i) + 1]]])); },
  afterSep(s) { hk.sep.clear(); for (const [i, q] of hk.pre) hk.sep.set(i, Math.hypot(s[base(i)] - q[0], s[base(i) + 1] - q[1]) / ONE); },
  unit(i, u, dx, dz, hold, post) { hk.unit.set(i, { dx, dz, hold, post, halted: u.halted }); },
  haltRaw(sd, f, raw, kept) { if (!mainPass) return;
    if (raw) { add('B2 raw halts'); if (!kept) add('B2 halts suppressed'); }
    if (raw && !kept) haltSuppressedNow.add(`${sd < 1 ? -1 : 1}:${f}`); },
  branch(i, which) { if (mainPass) branchNow.set(i, which); },
  reread(w) { if (mainPass) add('P re-read due'); },
  onPostOk(w) { if (mainPass) add('P team on post'); },
  verdict(w, v, was, push, weight, rest, ceiling, own, foe, widow) { if (!mainPass) return;
    // §4.11's objective weight and §4.10's odds, at the moment the verdict is decided. O1 asks that pushes land on
    // objective lanes; if the weight never reaches here, that row is measuring a term the core is not applying.
    add('P verdict read'); add(`P weight ${weight | 0}`); add(`P ceiling ${(ceiling / 65536) | 0}`);
    add('P rest sum', (rest / 65536) | 0); add('P own sum', own | 0); add('P foe sum', foe | 0);
    if (widow) add('P widow'); if ((own | 0) > (foe | 0)) add('P odds ours'); else if ((foe | 0) > (own | 0)) add('P odds theirs');
    add(`P verdict ${['none', 'take', 'give', 'drift'][v] || v}`);
    if (v === was) add('P confirmed'); else add('P not confirmed');
    if (v === 2) { add('P give read'); if (v === was) add('P give confirmed'); if (push <= 0) add('P give at or below zero'); } },
  stepped(w, push, verdict) { if (!mainPass) return; add('P stepped');
    // per side, for the A11 windows: a step that was a give, and a step that was a take
    { const sd = w < 6 ? '-1' : '1';
      if (verdict === 2) winSteps.give[sd] = (winSteps.give[sd] || 0) + 1;
      if (verdict === 1) winSteps.take[sd] = (winSteps.take[sd] || 0) + 1; } if (push < 0) add('P stepped below zero');
    // WHAT THE CODE IS HOLDING, in the same units the sampler reads: the lowest push this run ever WROTE, against the
    // lowest the per-tick sampler ever SAW. Those two disagreed once (72 steps below zero against a sampled minimum of
    // 0 m) and one of them is wrong.
    pushWrittenMin = Math.min(pushWrittenMin, push / ONE); pushWrittenMax = Math.max(pushWrittenMax, push / ONE); },
  halted(h) { hk.halted = h.map((a) => a.slice()); },
};

mainPass = true;
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
    haltSuppressedNow.clear();
    step(st, 0, 0, 0, ONE, 0);
    const tick = s[L.O_TICK];
    const liveT = ARMOUR.filter(alive), liveM = RIFLES.filter(alive);
    const mvOf = (i) => { const q = pre.get(i); return q ? Math.hypot(s[base(i)] - q[0], s[base(i) + 1] - q[1]) / ONE : 0; };

    // ================= ARMOUR =================
    // ON THE LINE = within 40 m of its post AND not a column. A column (RULED, the owner 2026-09-16 21:20) is a tank that has
    // not yet stood on its post (within 1.5 m, hull-down pick included) since it spawned or respawned.
    for (const i of liveT) {
      if (!aliveBefore.get(i) || mvOf(i) > 5) stood.delete(i);
      const p = T.postOf(s, L.O_TACTICS, i, tick), sd = sideOf(i), line = seamOfCore(st, p.x) + sd * p.depth;
      let hold = line;
      if (!p.bounding) { let br = -Infinity; for (let c = -2; c <= 2; c++) { const z = line + c * 2 * ONE; const rise = groundAt(st, p.x, z - sd * 6 * ONE) - groundAt(st, p.x, z); if (rise > br) { br = rise; hold = z; } } }
      if (Math.hypot(s[base(i)] - p.x, s[base(i) + 1] - hold) <= 1.5 * ONE) stood.add(i);
    }
    const onLine = (i) => { if (!stood.has(i)) return false; const p = T.postOf(s, L.O_TACTICS, i, tick); const tz = seamOfCore(st, p.x) + sideOf(i) * p.depth; return Math.abs(s[base(i) + 1] - tz) <= 40 * ONE; };
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
      if (CAUSE && u.hold !== undefined) { if (!holdBeforeNext.has(i)) holdBeforeNext.set(i, u.hold); }
      // A3: the separation push undoes the tank's own step
      if (own && sep > 0.005) add('A3 fights');
      add('A3 tank-ticks');
      if (!own) { add('A2 holding'); if (mv - sep >= 0.02) add('A2 holding moved'); }
      if (line) { countLine[sd]++; if (mv > 0.02) movingLine[sd]++; }
      if (own && sep <= 0.005 && line) {
        const dir = [Math.sign(u.dx), Math.sign(u.dz)], pd = lastDir.get(i);
        if (pd && ((pd[0] && dir[0] && pd[0] !== dir[0]) || (pd[1] && dir[1] && pd[1] !== dir[1]))) {
          add('A2 flips'); const lf = lastFlip.get(i); const quick = lf !== undefined && tick - lf < 120;
          if (quick) add('A2 fidgets'); lastFlip.set(i, tick);
          // WHAT FLIPPED AND WHAT THE TANK WAS: the axis, its role, and whether it was on post. A row that trips on
          // 2.11% wants a cause, not a comparison with another seed set.
          if (CAUSE) { const bd = T.postOf(s, L.O_TACTICS, i, tick).bounding;
            // WHAT MOVED UNDER A FIDGET: its own hold against the tick before, and how far it was from it. A tank
            // that reverses because its hold jumped is obeying §4.1; one that reverses with a stationary hold is
            // oscillating, and that would be the mover's own fault.
            if (quick) { const hNow = u.hold, hWas = holdBefore.get(i);
              const moved = hWas === undefined ? null : Math.abs(hNow - hWas) / ONE;
              const gap = Math.abs(hNow - s[base(i) + 1]) / ONE;
              add(moved === null ? 'A2 fidget hold unknown' : moved > 0.05 ? 'A2 fidget hold moved' : 'A2 fidget hold still');
              add(`A2 fidget gap ${gap < 0.25 ? '<0.25' : gap < 1 ? '0.25-1' : gap < 4 ? '1-4' : '4+'}`);
              add(`A2 fidget branch ${branchNow.get(i) || 'none'}`);
              if (moved !== null && moved > 0.05) add(`A2 fidget hold jump ${moved < 1 ? '<1' : moved < 3 ? '1-3' : '3+'}`); }
            const axis = (pd[0] && dir[0] && pd[0] !== dir[0]) ? (pd[1] && dir[1] && pd[1] !== dir[1] ? 'both' : 'x') : 'z';
            add(`A2 flip axis ${axis}`); if (quick) add(`A2 fidget axis ${axis}`);
            add(`A2 flip ${bd ? 'bounding' : 'overwatch'}`); if (quick) add(`A2 fidget ${bd ? 'bounding' : 'overwatch'}`); }
            // (on-post at the moment of a flip is not asked here: the row's own `onPostNow` is built later in the
            // tick, and calling it from up here read as a ReferenceError rather than a number)
        }
        lastDir.set(i, dir);
      }
      if (!own && line) { add('A7 holding'); if (Math.abs(wrap(s[base(i) + L.U_HEADING] - (sideOf(i) < 0 ? 0 : 32768))) <= 5461) add('A7 facing'); }
      const p = T.postOf(s, L.O_TACTICS, i, tick); const pk = `${p.x},${p.depth}`;
      if (prevPost.has(i) && prevPost.get(i) !== pk) { w10[sd]++;
        // A POST CHANGE IS EITHER A SLOT (x) OR A LINE (depth): the first is a scoot, the second a leg swap or a push.
        if (CAUSE) { const was = prevPost.get(i).split(','); add(was[0] !== String(p.x) ? 'A4a change of slot' : 'A4a change of line'); } }
      prevPost.set(i, pk);
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
      // WHERE THE GUNS ARE ALONG THE SEAM, and where the slots they were sent to are. A9's gap is now a spread
      // problem - every short metre has two or more tanks within reach - so this asks whether one flank is simply
      // not manned, and whether that is the slots' doing or the tanks'.
      if (A9WHY && sd === -1) { for (let xm = -81; xm < 81; xm++) {
        // HOW STEEP THE SEAM IS THERE. A sample is a metre of x, but the seam's z moves with it: where the line
        // climbs, two neighbouring samples are far apart in the world and one tank covers fewer of them.
        const slope = Math.abs(seamOfCore(st, (xm + 1) * ONE) - seamOfCore(st, xm * ONE)) / ONE;
        a9slope[xm] = (a9slope[xm] || 0) + slope; a9slopeN[xm] = (a9slopeN[xm] || 0) + 1; } }
      if (A9WHY) { for (const i of ls) a9x[sd < 0 ? 0 : 1].push(s[base(i)] / ONE);
        for (let w = 0; w < 6; w++) a9slot[sd < 0 ? 0 : 1].push(T.slotX(s[L.O_TACTICS + T.TAC_SLOT + (sd < 0 ? w : w + 6)]) / ONE); }
      // RULED (the owner 2026-09-16): the share of seam-metre samples covered by >= 2, not a tick-union.
      for (let xm = -81; xm <= 81; xm++) { const zx = seamOfCore(st, xm * ONE); let n = 0;
        for (const i of ls) if (Math.hypot(s[base(i)] - xm * ONE, s[base(i) + 1] - zx) < 46 * ONE) n++;
        add('A9 samples'); if (n < 2) { add('A9 gap'); if (A9WHY) { a9gap[xm] = (a9gap[xm] || 0) + 1; a9live.push(ls.length);
          // HOW MANY OF THAT SIDE WERE NEAR THE SEAM AT ALL: a tank still walking in from the back edge is further
          // than its gun reaches, so it covers nothing wherever it is pointed.
          a9near.push(ls.filter((i) => Math.abs(s[base(i) + 1] - seamOfCore(st, s[base(i)])) < 46 * ONE).length); } }
        if (A9WHY) a9all[xm] = (a9all[xm] || 0) + 1; }
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
      // H1 BY FIFTH OF THE RUN (2026-09-19): it passes on every seed over one minute and falls under its bar on two
      // over five, so the question is whether it decays and how fast. Counted per fifth, with the walk-in share
      // beside it, because a hull that has never reached a post cannot be on one.
      { const fifth = Math.min(4, Math.floor(tick * 5 / TICKS));
        add(`H1 fifth ${fifth} ticks`); if (onPostNow(i)) add(`H1 fifth ${fifth} on post`);
        if (!settled) add(`H1 fifth ${fifth} walking in`); }
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
      // WHAT THE LANE IS ALLOWED, not only what it holds: §4.11 gives an objective's lane a ceiling of its own, and
      // O1 asks that lane to sit 6 m HIGHER than the rest. If the ceiling there is lower, the row cannot be met.
      if (CAUSE) { const lt = T.laneTerms(s, L.O_TACTICS, w < 6 ? -1 : 1, s[L.O_TACTICS + T.TAC_SLOT + w]);
        // AT ITS REST OR NOT: an ordinary lane's rest is 0, which is where every lane starts, so it is there for
        // nothing. An objective lane's rest is +8 and it has to be STEPPED there. And an objective that moves takes
        // the +8 with it, leaving the lane that climbed to drift back down.
        if (Math.abs(pu - lt.rest / ONE) < 0.01) add(on ? 'O1 lane at rest' : 'O1 rest at rest');
        if (on && pu >= 8) add('O1 lane at or above 8');
        const okey = `${w}`; const was = objLaneWas.get(okey); objLaneWas.set(okey, on);
        if (was !== undefined && was !== on) add('O1 lane changed hands');
        add(on ? 'O1 lane ceiling sum' : 'O1 rest ceiling sum', (lt.ceiling / ONE) | 0);
        add(on ? 'O1 lane rest sum' : 'O1 rest rest sum', (lt.rest / ONE) | 0);
        add(on ? 'O1 lane n2' : 'O1 rest n2'); }
      add(on ? 'O1 on n' : 'O1 off n'); add(on ? 'O1 on push' : 'O1 off push', pu);
    }
    for (let o = 0; o < 3; o++) {
      const px = T.slotX(lanes[o]), pz = seamOfCore(st, px);
      const near = (sd) => liveT.some((i) => sideOf(i) === sd && Math.hypot(s[base(i)] - px, s[base(i) + 1] - pz) < 46 * ONE);
      add(`O2 ticks ${o}`); if (near(-1) && near(1)) add(`O2 fought ${o}`);
      const h = T.objectiveHolder(s, L.O_TACTICS, o);
      if (h !== 0) { if (holderWas[o] !== 0 && holderWas[o] !== h) changedHands = true; holderWas[o] = h; }
    }
    const push = { '-1': [], '1': [] };
    for (let w = 0; w < 12; w++) { const sd = w < 6 ? '-1' : '1'; const p = s[L.O_TACTICS + T.TAC_PUSH + w] / ONE; push[sd].push(p);
      pushSeenMin = Math.min(pushSeenMin, p); pushSeenMax = Math.max(pushSeenMax, p); if (p < 0) win.give[sd]++; add('A11c team-ticks'); if (p !== 0) add('A11c off default');
      // WHAT THE TEAM DECIDED, not only where it ended up: §4.10's verdict word, and whether this reading agreed with
      // the last one (a step needs two). A11b says no team ever gives ground; this says whether GIVE is never reached
      // or only never confirmed.
      if (VERDICTS) { pushSeen.push(p);
        // THE STEPS THEMSELVES, not the verdict word - that word persists between re-reads, so counting its ticks
        // counts waiting, not deciding. This counts every change of the push word and where it went.
        const wasP = pushWasV[w]; pushWasV[w] = p;
        if (wasP !== undefined && p !== wasP) { pushMoves.push([wasP, p]); }
        const v = s[L.O_TACTICS + T.TAC_VERDICT + w];
        verdictCount[v] = (verdictCount[v] || 0) + 1;
        const was = verdictWas[w]; verdictWas[w] = v;
        if (v === 2) { verdictCount.giveSeen = (verdictCount.giveSeen || 0) + 1; if (was === 2) verdictCount.giveConfirmed = (verdictCount.giveConfirmed || 0) + 1; } } }
    for (const i of liveT) { const p = T.postOf(s, L.O_TACTICS, i, tick); if ((s[base(i) + 1] - seamOfCore(st, p.x)) * sideOf(i) < 0) win.cross[String(sideOf(i))]++; }
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
    for (const i of liveM) { const k = `${sideOf(i)}:${squadOf(i)}`; const w = w5.get(k) || { halted: false, moving: false, allOnPost: true, outTicks: 0, ticks: 0 };
      const u = hk.unit.get(i); if (u) { if (u.halted) w.halted = true; if (mvOf(i) > 0.02 && mvOf(i) < 5) w.moving = true; if (!(u.dx === 0 && u.dz === 0)) w.allOnPost = false; } w5.set(k, w); }
    for (const [k, w] of w5) { w.ticks++; if (b3OutNow.get(Number(k.split(':')[0]))) w.outTicks++;
      // §11.2's suppression, per window: did any fire team of this side have a halt cancelled by its lower neighbour
      // while this window ran? That is the rule's own collision, and B2's failures are all the halt half.
      for (const key of haltSuppressedNow) if (key.split(':')[0] === k.split(':')[0]) w.suppressed = true; }
    if ((t + 1) % 300 === 0) { for (const [, w] of w5) { add('B2 squad-windows'); const bad = !w.halted || (!w.allOnPost && !w.moving);
      if (bad) add('B2 fail');
      // WHICH HALF FAILED: no team halted in the window, or nobody moved while not all were on post.
      if (CAUSE && bad) { if (!w.halted) add('B2 no halt'); if (!w.allOnPost && !w.moving) add('B2 no mover');
        if (!w.halted) add(w.suppressed ? 'B2 no halt with a suppression' : 'B2 no halt with none'); }
      if (CAUSE && !bad && w.suppressed) add('B2 passing window with a suppression');
      if (SHARE) { const share = w.ticks ? w.outTicks / w.ticks : 0;
        add(bad ? 'B2 fail out-tick share x1000' : 'B2 pass out-tick share x1000', Math.round(share * 1000));
        add(bad ? 'B2 fail windows' : 'B2 pass windows'); } } w5.clear(); }
    // B3 spread of men on post, per side
    for (const sd of [-1, 1]) {
      const on = liveM.filter((i) => sideOf(i) === sd && hk.unit.get(i) && hk.unit.get(i).dx === 0 && hk.unit.get(i).dz === 0);
      if (on.length < 6) continue;
      const zs = on.map((i) => (s[base(i) + 1] - seamOfCore(st, s[base(i)])) / ONE), xs = on.map((i) => s[base(i)] / ONE);
      const sdev = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) * (v - m)))); };
      add('B3 side-ticks'); const zsd = sdev(zs), xsd = sdev(xs);
      if (zsd < 4 || zsd > 12) add('B3 z out'); if (xsd < 20 || xsd > 60) add('B3 x out');
      // KEPT FOR THE SHARE QUESTION (2026-09-19): whether THIS side was out of band on THIS tick, so a B2 window and
      // a B4 follow can be counted against it. A row that fails on the same ticks as B3 is the same knot; one that
      // fails just as often on the ticks B3 is in band is its own fault.
      b3OutNow.set(sd, (zsd < 4 || zsd > 12 || xsd < 20 || xsd > 60));
      // THE PROBE COUNTS THE ROW'S OWN EVENTS, and says so in the row's own counters (2026-09-19). The last attempt
      // kept its numbers in an array of its own and disagreed with the row by three orders of magnitude; anything
      // counted here goes through `add` beside the row, so the two cannot drift apart unseen.
      if (B3WHY) { add('B3 probe events');
        if (zsd < 4) add('B3 z tight'); else if (zsd > 12) add('B3 z loose');
        if (xsd < 20) add('B3 x tight'); else if (xsd > 60) add('B3 x loose');
        // and how far out, in buckets, so "too loose" carries a size
        add(`B3 zsd ${zsd < 4 ? '<4' : zsd <= 12 ? '4-12' : zsd <= 20 ? '12-20' : zsd <= 40 ? '20-40' : '>40'}`);
        add(`B3 xsd ${xsd < 10 ? '<10' : xsd < 20 ? '10-20' : xsd <= 60 ? '20-60' : '>60'}`); }
    }
    // B4 follow the push: squad pushNear and mean z (relative to seam) of its men on post
    const squadNow = new Map();
    for (const i of liveM) { const u = hk.unit.get(i); if (!u || u.dx !== 0 || u.dz !== 0) continue;
      const sd = sideOf(i), sq = squadOf(i), k = `${sd}:${sq}`;
      const anchor = s[L.O_SQUADS + (sd < 0 ? 0 : L.SQUADS_PER_SIDE) + sq];
      const e = squadNow.get(k) || { push: T.pushNear(s, L.O_TACTICS, sd, anchor), z: [] };
      e.z.push((s[base(i) + 1] - seamOfCore(st, s[base(i)])) * -sd / ONE); squadNow.set(k, e); }
    if (SHARE) for (const [k, e] of squadNow) e.b3Out = !!b3OutNow.get(Number(k.split(':')[0]));
    pushHist.push(squadNow);
    // B6 losses and arrivals of men
    for (const i of RIFLES) { const sd = String(sideOf(i)); if (aliveBefore.get(i) && !alive(i)) win.menLost[sd]++;
      if (!aliveBefore.get(i) && alive(i)) { win.menIn[sd]++; add('B6 arrivals'); if (Math.abs(s[base(i) + 1]) < 60 * ONE) add('B6 appeared on the line'); } }

    if (CAUSE) { for (const [i, h] of holdBeforeNext) holdBefore.set(i, h); holdBeforeNext.clear(); }
    for (let i = 0; i < 96; i++) aliveBefore.set(i, alive(i));
    if ((t + 1) % 600 === 0) { for (const sd of ['-1', '1']) { add('A4a windows'); if (w10[sd] === 0) add('A4a still');
      if (CAUSE) add(`A4a changes ${w10[sd] === 0 ? '0' : w10[sd] <= 2 ? '1-2' : w10[sd] <= 6 ? '3-6' : '7+'}`);
      w10[sd] = 0; } }
    if ((t + 1) % 3600 === 0) {
      for (const sd of ['-1', '1']) {
        add('A11 windows'); if (win.cross[sd] === 0) add('A11a no crossing'); if (win.give[sd] === 0) add('A11b no giving');
        // WHY THE WINDOW WAS SHORT, with the instrument already here: no step of that kind at all, or steps that were
        // taken and still did not carry a team across the seam / below zero inside the window.
        if (CAUSE) {
          if (win.cross[sd] === 0) add((winSteps.take[sd] || 0) === 0 ? 'A11a no take step at all' : 'A11a took steps but no crossing');
          if (win.give[sd] === 0) add((winSteps.give[sd] || 0) === 0 ? 'A11b no give step at all' : 'A11b gave steps but none below zero');
        }
        winSteps.give[sd] = 0; winSteps.take[sd] = 0;
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
    // THE SAME QUESTION AS B2's: was the line out of band while the squad was meant to be following? Counted over the
    // window the follow was given, so a squad that never followed while its line was in band is its own fault.
    if (SHARE) { let out = 0, seen = 0;
      for (let u = t; u < Math.min(pushHist.length, t + 600); u++) { const f = pushHist[u].get(k); if (!f) continue; seen++; if (f.b3Out) out++; }
      const share = seen ? Math.round(1000 * out / seen) : 0;
      add(ok ? 'B4 followed windows' : 'B4 missed windows');
      add(ok ? 'B4 followed out share x1000' : 'B4 missed out share x1000', share); }
  }
}
function mean(a) { return a.reduce((x, y) => x + y, 0) / a.length; }

mainPass = false;                 // everything below steps worlds of its own; the push hooks must not count them
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
  // THE SAMPLE SIZE BESIDE THE SHARE. Seed 12 printed "0.00%" for a run whose pushed team-ticks were zero - 0 of 0
  // read as an army that never pushed where nothing had been measured at all. The assert is untouched.
  ['O1  pushed >= 16 team-ticks on an objective lane',
    `${r['O1 pushed on a lane'] || 0} of ${r['O1 pushed team-ticks'] || 0} = ${P(pct('O1 pushed on a lane', 'O1 pushed team-ticks'))}`,
    pct('O1 pushed on a lane', 'O1 pushed team-ticks') >= 0.6],
  ['O1  mean push on objective lanes minus the rest',
    `${(r['O1 on push'] / r['O1 on n'] - r['O1 off push'] / r['O1 off n']).toFixed(2)} m `
    + `(on ${r['O1 on n'] || 0} team-ticks against ${r['O1 off n'] || 0})`,
    r['O1 on push'] / r['O1 on n'] - r['O1 off push'] / r['O1 off n'] >= 6],
  ['O2  ticks with both sides inside 46 m (RIDGE/HOLLOW/GAP)', [0, 1, 2].map((o) => P(pct(`O2 fought ${o}`, `O2 ticks ${o}`))).join(' / '), [0, 1, 2].every((o) => pct(`O2 fought ${o}`, `O2 ticks ${o}`) >= 0.6)],
  ['O3  seeds on which an objective changed hands', `${r['O3 changed hands'] || 0} of ${r['O3 seeds']}`, (r['O3 changed hands'] || 0) >= 4],
  // O4 is the CLIENT's row and this probe cannot run it: the test lives in packages/blwp-client
  // (test/objective-markers.test.js) and drives a real page. Its verdict is not invented here - this row says where
  // the answer comes from, and stays red in this table so nobody reads a core run as having answered it.
  ['O4  client draws the markers (blwp-client test/objective-markers.test.js, not this probe)',
    'run it there - passing on 0.0.1659', false],
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
  if (A9WHY) {
    const xs = Object.keys(a9all).map(Number).sort((a, b) => a - b);
    const band = (lo, hi) => { let g = 0, t = 0; for (const x of xs) if (x >= lo && x <= hi) { g += a9gap[x] || 0; t += a9all[x] || 0; } return t ? (100 * g / t).toFixed(0) + '%' : '-'; };
    console.log(`A9 gaps by where on the seam they are: |x|<=20 ${band(-20, 20)}, 20-45 ${band(20, 45)} / ${band(-45, -20)}, `
      + `45-65 ${band(45, 65)} / ${band(-65, -45)}, 65-81 ${band(65, 81)} / ${band(-81, -65)}`);
    const live = a9live.slice().sort((a, b) => a - b);
    if (live.length) console.log(`when a metre was short, that side had ${live[0]} to ${live[live.length - 1]} tanks alive, `
      + `median ${live[Math.floor(live.length / 2)]}`);
    for (const k of [0, 1]) {
      const xs = a9x[k].slice().sort((a, b) => a - b), sl = a9slot[k].slice().sort((a, b) => a - b);
      if (!xs.length) continue;
      const at = (a, f) => a[Math.floor(a.length * f)];
      console.log(`${k === 0 ? 'bull' : 'bear'} hulls along the seam: min ${xs[0].toFixed(0)}, q1 ${at(xs, 0.25).toFixed(0)}, `
        + `median ${at(xs, 0.5).toFixed(0)}, q3 ${at(xs, 0.75).toFixed(0)}, max ${xs[xs.length - 1].toFixed(0)} m; `
        + `past +40 ${(100 * xs.filter((v) => v > 40).length / xs.length).toFixed(0)}%, past -40 `
        + `${(100 * xs.filter((v) => v < -40).length / xs.length).toFixed(0)}%; `
        + `slots they were sent to: min ${sl[0].toFixed(0)}, max ${sl[sl.length - 1].toFixed(0)}, `
        + `past +40 ${(100 * sl.filter((v) => v > 40).length / sl.length).toFixed(0)}%`);
    }
    { const band = (lo, hi) => { let sum = 0, n = 0; for (let x = lo; x <= hi; x++) { sum += a9slope[x] || 0; n += a9slopeN[x] || 0; } return n ? (sum / n).toFixed(2) : '-'; };
      console.log(`the seam's own climb per metre of x: -81..-65 ${band(-81, -65)}, -65..-45 ${band(-65, -45)}, `
        + `-45..-20 ${band(-45, -20)}, |x|<=20 ${band(-20, 20)}, +20..45 ${band(20, 45)}, +45..65 ${band(45, 65)}, `
        + `+65..81 ${band(65, 81)} m`); }
    const near = a9near.slice().sort((a, b) => a - b);
    if (near.length) console.log(`and of those, within their own gun's reach of the seam: median `
      + `${near[Math.floor(near.length / 2)]}, q1 ${near[Math.floor(near.length / 4)]}, q3 ${near[Math.floor(near.length * 3 / 4)]}; `
      + `short metres with NOBODY in reach ${(100 * near.filter((n) => n === 0).length / near.length).toFixed(0)}%, `
      + `with one ${(100 * near.filter((n) => n === 1).length / near.length).toFixed(0)}%, `
      + `with two or more ${(100 * near.filter((n) => n >= 2).length / near.length).toFixed(0)}%`);
  }
  if (VERDICTS && pushMoves.length) {
    const down = pushMoves.filter(([a, b]) => b < a), up = pushMoves.filter(([a, b]) => b > a);
    const belowZero = pushMoves.filter(([, b]) => b < 0);
    const fromZeroDown = pushMoves.filter(([a, b]) => a === 0 && b < a);
    console.log(`push steps: ${pushMoves.length} - down ${down.length}, up ${up.length}, landing below zero `
      + `${belowZero.length}; steps taken FROM zero downward ${fromZeroDown.length}`);
  }
  if (VERDICTS && pushSeen.length) {
    const a = pushSeen.slice().sort((x, y) => x - y);
    const at = (f) => a[Math.floor(a.length * f)];
    console.log(`the push word itself, over ${a.length} team-ticks: min ${a[0].toFixed(0)} m, `
      + `p05 ${at(0.05).toFixed(0)}, median ${at(0.5).toFixed(0)}, p95 ${at(0.95).toFixed(0)}, max ${a[a.length - 1].toFixed(0)} m; `
      + `below zero ${(100 * a.filter((v) => v < 0).length / a.length).toFixed(2)}%`);
  }
  if (VERDICTS) {
    const n = (k) => verdictCount[k] || 0;
    const tot = n(0) + n(1) + n(2) + n(3);
    console.log(`team verdicts over ${tot} team-ticks: none ${(100 * n(0) / tot).toFixed(1)}%, take ${(100 * n(1) / tot).toFixed(1)}%, `
      + `give ${(100 * n(2) / tot).toFixed(1)}%, drift ${(100 * n(3) / tot).toFixed(1)}%; give readings ${n('giveSeen')}, `
      + `of which confirmed by the reading before ${n('giveConfirmed')}`);
  }
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
if (B3WHY) {
  const n = (k) => r[k] || 0;
  console.log(`B3 counts, probe against the row: side-ticks ${n('B3 side-ticks')}, probe events ${n('B3 probe events')}`
    + ` (${n('B3 side-ticks') === n('B3 probe events') ? 'AGREE' : 'DISAGREE'}); row z out ${n('B3 z out')}, `
    + `probe z tight ${n('B3 z tight')} + loose ${n('B3 z loose')} = ${n('B3 z tight') + n('B3 z loose')}; `
    + `row x out ${n('B3 x out')}, probe x tight ${n('B3 x tight')} + loose ${n('B3 x loose')} = `
    + `${n('B3 x tight') + n('B3 x loose')}`);
  console.log(`B3 z spread buckets (band 4-12 m): <4 ${n('B3 zsd <4')}, 4-12 ${n('B3 zsd 4-12')}, 12-20 `
    + `${n('B3 zsd 12-20')}, 20-40 ${n('B3 zsd 20-40')}, >40 ${n('B3 zsd >40')}`);
  console.log(`B3 x spread buckets (band 20-60 m): <10 ${n('B3 xsd <10')}, 10-20 ${n('B3 xsd 10-20')}, 20-60 `
    + `${n('B3 xsd 20-60')}, >60 ${n('B3 xsd >60')}`);
}

if (SHARE) {
  const n = (k) => r[k] || 0;
  const share = (kind) => { const w = n(`B2 ${kind} windows`); return w ? (n(`B2 ${kind} out-tick share x1000`) / w / 10).toFixed(1) + '%' : '-'; };
  const b4 = (kind) => { const w = n(`B4 ${kind} windows`); return w ? (n(`B4 ${kind} out share x1000`) / w / 10).toFixed(1) + '%' : '-'; };
  console.log(`B4 against B3: the ${n('B4 missed windows')} push changes the squads did not follow spent ${b4('missed')} `
    + `of their window with that side's line out of band; the ${n('B4 followed windows')} they did follow spent ${b4('followed')}.`);
  console.log(`B2 against B3: failing windows ${n('B2 fail windows')} spent ${share('fail')} of their ticks with that `
    + `side's line out of band; passing windows ${n('B2 pass windows')} spent ${share('pass')}. A row that fails on the `
    + `same ticks B3 fails is the same knot; one that does not is its own.`);
}
{
  const n = (k) => r[k] || 0;
  const pc = (a, b) => (n(b) ? (100 * n(a) / n(b)).toFixed(1) + '%' : '-');
  console.log(`the push re-read (WAR_TACTICS §4.10): due ${n('P re-read due')}, of which the team was on post `
    + `${n('P team on post')} (${pc('P team on post', 'P re-read due')}) - the rest skipped by rule (a); `
    + `verdicts read ${n('P verdict read')}: take ${n('P verdict take')}, give ${n('P verdict give')}, `
    + `drift ${n('P verdict drift')}, none ${n('P verdict none')}; confirmed ${n('P confirmed')} `
    + `(${pc('P confirmed', 'P verdict read')}), steps taken ${n('P stepped')}`);
  console.log(`the push word, written against seen: lowest written ${pushWrittenMin.toFixed(0)} m, highest written `
    + `${pushWrittenMax.toFixed(0)} m; lowest seen by the per-tick sampler ${pushSeenMin.toFixed(0)} m, highest seen `
    + `${pushSeenMax.toFixed(0)} m`);
  console.log(`§4.11's weight at the verdict: w0 ${n('P weight 0')}, w1 ${n('P weight 1')}, w2 ${n('P weight 2')}, `
    + `w3 ${n('P weight 3')}; ceilings 16 ${n('P ceiling 16')}, 24 ${n('P ceiling 24')}, 32 ${n('P ceiling 32')}, `
    + `40 ${n('P ceiling 40')}; widows ${n('P widow')}; odds ours ${n('P odds ours')}, theirs ${n('P odds theirs')}, `
    + `level ${n('P verdict read') - n('P odds ours') - n('P odds theirs')}; mean own `
    + `${(n('P own sum') / Math.max(n('P verdict read'), 1)).toFixed(1)}, mean foe `
    + `${(n('P foe sum') / Math.max(n('P verdict read'), 1)).toFixed(1)}`);
  console.log(`O1's own denominators: pushed team-ticks (push >= 16) ${n('O1 pushed team-ticks')}, of them on an `
    + `objective lane ${n('O1 pushed on a lane')}; team-ticks on a lane ${n('O1 on n')}, off it ${n('O1 off n')}`);
  console.log(`the GIVE path: read ${n('P give read')} times, confirmed ${n('P give confirmed')}, of the reads `
    + `${n('P give at or below zero')} were at a push already <= 0; steps that landed below zero ${n('P stepped below zero')}`);
}
if (CAUSE) {
  const n = (k) => r[k] || 0;
  console.log(`A2's flips: axis x ${n('A2 flip axis x')}, z ${n('A2 flip axis z')}, both ${n('A2 flip axis both')}; `
    + `bounding ${n('A2 flip bounding')}, overwatch ${n('A2 flip overwatch')}. The fidgets inside 2 s: axis x `
    + `${n('A2 fidget axis x')}, z ${n('A2 fidget axis z')}, both ${n('A2 fidget axis both')}; bounding `
    + `${n('A2 fidget bounding')}, overwatch ${n('A2 fidget overwatch')}`);
  console.log(`A2's fidgets, what moved under them: hold moved ${n('A2 fidget hold moved')}, hold still `
    + `${n('A2 fidget hold still')}, unknown ${n('A2 fidget hold unknown')}; the jump when it moved: <1 m `
    + `${n('A2 fidget hold jump <1')}, 1-3 m ${n('A2 fidget hold jump 1-3')}, 3+ m ${n('A2 fidget hold jump 3+')}; `
    + `distance to the hold at the flip: <0.25 ${n('A2 fidget gap <0.25')}, 0.25-1 ${n('A2 fidget gap 0.25-1')}, `
    + `1-4 ${n('A2 fidget gap 1-4')}, 4+ ${n('A2 fidget gap 4+')}`);
  console.log(`A2's fidgets, which branch stepped them: backoff ${n('A2 fidget branch backoff')}, heldAfterGiving `
    + `${n('A2 fidget branch heldAfterGiving')}, crossing ${n('A2 fidget branch crossing')}, arriving `
    + `${n('A2 fidget branch arriving')}, walking ${n('A2 fidget branch walking')}, inBand `
    + `${n('A2 fidget branch inBand')}, none ${n('A2 fidget branch none')}`);
  console.log(`A4a's post changes: of slot ${n('A4a change of slot')}, of line ${n('A4a change of line')}; windows by `
    + `how many changes they held: none ${n('A4a changes 0')}, 1-2 ${n('A4a changes 1-2')}, 3-6 ${n('A4a changes 3-6')}, `
    + `7+ ${n('A4a changes 7+')}`);
  console.log(`B2's failures: ${n('B2 fail')} of ${n('B2 squad-windows')} windows - no team halted in ${n('B2 no halt')}, `
    + `nobody moved while some were off post in ${n('B2 no mover')}`);
  console.log(`O1's lanes against the rest: an objective lane holds mean push `
    + `${(n('O1 on push') / Math.max(n('O1 on n'), 1)).toFixed(2)} m with a mean ceiling of `
    + `${(n('O1 lane ceiling sum') / Math.max(n('O1 lane n2'), 1)).toFixed(1)} m and a rest of `
    + `${(n('O1 lane rest sum') / Math.max(n('O1 lane n2'), 1)).toFixed(1)} m; the rest of the line holds `
    + `${(n('O1 off push') / Math.max(n('O1 off n'), 1)).toFixed(2)} m with a ceiling of `
    + `${(n('O1 rest ceiling sum') / Math.max(n('O1 rest n2'), 1)).toFixed(1)} m and a rest of `
    + `${(n('O1 rest rest sum') / Math.max(n('O1 rest n2'), 1)).toFixed(1)} m`);
  console.log(`O1's lanes at their rest: an objective lane sits exactly at its +8 rest on `
    + `${(100 * n('O1 lane at rest') / Math.max(n('O1 on n'), 1)).toFixed(1)}% of its team-ticks and at or above 8 m on `
    + `${(100 * n('O1 lane at or above 8') / Math.max(n('O1 on n'), 1)).toFixed(1)}%; an ordinary lane sits at its `
    + `0 rest on ${(100 * n('O1 rest at rest') / Math.max(n('O1 off n'), 1)).toFixed(1)}%. The objective moved lane `
    + `${n('O1 lane changed hands')} times.`);
  console.log(`A11a's short windows: ${n('A11a no crossing')} - of them ${n('A11a no take step at all')} had NO take `
    + `step at all and ${n('A11a took steps but no crossing')} took steps that did not carry a team across`);
  console.log(`A11b's short windows: ${n('A11b no giving')} - of them ${n('A11b no give step at all')} had NO give `
    + `step at all and ${n('A11b gave steps but none below zero')} gave steps that did not reach below zero`);
  console.log(`§11.2's suppression: ${n('B2 halts suppressed')} of ${n('B2 raw halts')} raw halts were cancelled by a `
    + `lower neighbour; of the ${n('B2 no halt')} halt-half failures, ${n('B2 no halt with a suppression')} had a `
    + `suppression inside the window and ${n('B2 no halt with none')} had none; passing windows carrying a suppression `
    + `${n('B2 passing window with a suppression')}`);
}
{
  const n = (k) => r[k] || 0;
  const line = [0, 1, 2, 3, 4].map((f) => {
    const t = n(`H1 fifth ${f} ticks`);
    return t ? `${(100 * n(`H1 fifth ${f} on post`) / t).toFixed(1)}% (walking in ${(100 * n(`H1 fifth ${f} walking in`) / t).toFixed(0)}%)` : '-';
  });
  console.log(`H1 by fifth of the run: ${line.join('  |  ')}`);
}
console.log(`${rows.length - red} of ${rows.length} rows pass (seeds ${SEEDS.join(',')}, ${TICKS} ticks)`);
process.exit(red ? 1 : 0);
