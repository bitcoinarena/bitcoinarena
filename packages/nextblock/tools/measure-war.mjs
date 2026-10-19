// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
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
const B3POP = process.argv.includes('--b3pop');
// B3's REMAINING RED, SPLIT BEFORE ANY HYPOTHESIS (2026-09-19). Both halves are red and the ruling owns part of the
// x miss through the anchor draw. This prints, per failing tick, WHICH clause failed and what the code was holding
// when it did - the side's anchor spread and the floor it implies, the men's spread, and for z whether the squad
// would have been inside the band if only its halted men were counted. No population is changed and no band moves.
const B3SPLIT = process.argv.includes('--b3split');
const b3x = [], b3z = [];
const pushWasSq = new Map(), pushMovedAt = new Map();
const CAUSE = process.argv.includes('--cause');
// A4a NAMES ITS WINDOW. The row is "a side held the same posts for ten whole seconds", and at 1 of 60 it is one
// window, not a tendency - so the aggregate cannot say which side of which seed stood still, or what it was holding
// while it did. This records, per window, the seed, the side, the tick range, how many changes it saw, and what the
// side had to change WITH: its live tanks, how many of them were bounding, and the scoot and slot words that a post
// change comes out of.
const A4AWHY = process.argv.includes('--a4awhy');
const a4aWindows = [];
// THE 20:30 GATES, TAKEN OFF IN THE COPY ONLY (2026-09-19). §4.10 as ruled has one cadence and no gates: "re-read
// every 5 s (300 ticks) per team", then take, give or drift. The core adds two things the 2026-09-16 20:30 re-ruling
// put there - (a) no re-read at all while a living tank of the team is off post, and (b) a step only when the reading
// repeats the last one. Six rows ask the push to DO something, so the question "how much of those six is the cadence"
// is answered by running them with the gates off and reading the same table. This changes NOTHING in the core: the
// gates are removed from the temp copy this tool already patches, and only when asked for on the command line.
// A11a: WHAT PUTS A HULL PAST THE SEAM (2026-09-19). The push gates do not move this row - 3 of 10 windows with them
// on and 3 with both off - so the mechanism is elsewhere. A hull's POST is across the seam only when its depth is
// negative, and the forward line is 16 - push, so only at push 24. Any other hull out there is there without its
// post: overshooting a bound, still crossing in x to a new slot (army.js calls that `crossing`, the scoot), or
// standing off after giving ground. Classified from the code's own branch word, never from the row's name.
const A11AWHY = process.argv.includes('--a11awhy');
const a11aKind = {}, a11aWindows = [];
// A11a's REMAINING HOLE (2026-09-19): why the side that never crossed never read TAKE. §4.10 decides on `own` and
// `foe` - living tanks of each side inside 46 m of the team's slot centre on the seam - and the core only computes
// them when the re-read survives gate (a), so these are every odds reading the code actually took, not a model of
// them. Skipped re-reads are counted separately: there the code held no odds at all.
const A11ODDS = process.argv.includes('--a11odds');
const a11odds = [];                               // one row per odds reading the core took
const a11due = {}, a11on = {};                    // per seed|side: re-reads due, and those that got past gate (a)
let curSeed = 0, curSt = null, curTick = 0;
// A11a's LAYOUT PRINT (2026-09-19). Asked: do side +1's slots sit under the steep climb, where a 40 m gap in x is
// 70 m in three dimensions past the 46 m reach? Printed with own and foe beside it. SAID PLAINLY IN THE NUMBERS:
// §4.10's odds are a TWO-DIMENSIONAL test - pressure() compares dx and dz against `reach` and never reads a height -
// so the climb cannot enter own or foe by any path in the code. The elevation columns are here because the question
// was asked and because they are A9's quantity at these same slots; they are not a term in this verdict, and this
// tool does not couple them into one.
const A11GEOM = process.argv.includes('--a11geom');
const a11geom = [];
const O1RIDGE = process.argv.includes('--o1ridge');
const o1ridge = {};
const o1onWas = new Map(), o1since = new Map();
const o1lag = { reached: 0, ticks: 0, lost: 0, lostTicks: 0, laneTicks: 0, belowRest: 0, deficit: 0 };
const B4WHY = process.argv.includes('--b4why');
const b4rows = [];
const NOGATE_A = process.argv.includes('--nogate-a') || process.argv.includes('--nogates');
const NOGATE_B = process.argv.includes('--nogate-b') || process.argv.includes('--nogates');
const SHARE = process.argv.includes('--share');
const b3OutNow = new Map();
const haltSuppressedNow = new Set();
const winSteps = { give: {}, take: {} };
// A11a RESTATED (RULED 2026-09-19): the row no longer asks a team of EACH side to cross every 60 s - on a seed
// where one side is three hulls down §4.10 forbids exactly that. It asks that SOME side crossed in every window,
// that no side crossed in no window of its run, and that a side which did not cross was outnumbered while it
// did not - which is the give-ground branch doing what §4.10 says, and is the clause that keeps the row biting.
const everCross = {};
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
// The gates themselves, removed from the copy when asked. `swap` replaces a line rather than adding after it, and it
// insists on finding it exactly once for the same reason `patch` does: a silently missed anchor would measure the
// core unchanged and read as "the cadence costs nothing".
const swap = (rel, from, to) => {
  const p = join(tmp, 'src', rel); const s = readFileSync(p, 'utf8');
  if (s.split(from).length !== 2) { console.error(`measure-war: line not found once in ${rel}:\n${from}`); process.exit(2); }
  writeFileSync(p, s.replace(from, to));
};
if (NOGATE_A) swap('rules/tactics.js', '    if (!teamOnPost(s, base, side, team, tick, seamAt, ground)) continue;',
  '    /* rule (a) off for this measurement */');
if (NOGATE_B) swap('rules/tactics.js', '    if (!confirmed) continue;', '    /* rule (b) off for this measurement */');
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
const T2 = await import(url('rules/army.js'));

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
  reread(w) { if (!mainPass) return; add('P re-read due');
    if (A11ODDS) { const k = `${curSeed}|${w < 6 ? '-1' : '1'}`; a11due[k] = (a11due[k] || 0) + 1; } },
  onPostOk(w) { if (!mainPass) return; add('P team on post');
    if (A11ODDS) { const k = `${curSeed}|${w < 6 ? '-1' : '1'}`; a11on[k] = (a11on[k] || 0) + 1; } },
  verdict(w, v, was, push, weight, rest, ceiling, own, foe, widow) { if (!mainPass) return;
    // §4.11's objective weight and §4.10's odds, at the moment the verdict is decided. O1 asks that pushes land on
    // objective lanes; if the weight never reaches here, that row is measuring a term the core is not applying.
    add('P verdict read'); add(`P weight ${weight | 0}`); add(`P ceiling ${(ceiling / 65536) | 0}`);
    add('P rest sum', (rest / 65536) | 0); add('P own sum', own | 0); add('P foe sum', foe | 0);
    if (widow) add('P widow'); if ((own | 0) > (foe | 0)) add('P odds ours'); else if ((foe | 0) > (own | 0)) add('P odds theirs');
    add(`P verdict ${['none', 'take', 'give', 'drift'][v] || v}`);
    if (A11ODDS) a11odds.push({ seed: curSeed, sd: w < 6 ? '-1' : '1', team: w % 6, own: own | 0, foe: foe | 0,
      weight: weight | 0, widow: !!widow, v, push: push / ONE, ceiling: ceiling / ONE });
    if (A11GEOM && curSt) {
      const sg = curSt.i32, side = w < 6 ? -1 : 1, team = w % 6, M = (q) => q / ONE;
      const px = T.slotX(sg[L.O_TACTICS + T.TAC_SLOT + w]);
      const pz = seamOfCore(curSt, px);
      const gSeam = groundAt(curSt, px, pz);
      // the seam sample 40 m away in x, which is A9's own reader: the seam's z there, and the ground under it
      const sx = px + Math.imul(40, ONE), sz = seamOfCore(curSt, sx), gS = groundAt(curSt, sx, sz);
      const k0 = Math.imul(team, 2);
      const i0 = (k0 << 3) | (side < 0 ? 0 : 4), i1 = ((k0 + 1) << 3) | (side < 0 ? 0 : 4);
      const hull = sg[L.O_UNITS + Math.imul(i0, L.U_WORDS) + L.U_STATE] !== 0 ? i0 : i1;
      const hb = L.O_UNITS + Math.imul(hull, L.U_WORDS);
      const hx = sg[hb + L.U_X], hz = sg[hb + L.U_Z], hg = groundAt(curSt, hx, hz);
      const d3 = Math.hypot(M(sx - hx), M(sz - hz), M(gS - hg));
      // AND HOW MANY HULLS EACH SIDE HAD AT ALL, at this same tick. `own` counts living tanks inside 46 m, so a low
      // `own` is either a thinner side or the same side spread wider. One column tells those two apart.
      let liveOwn = 0, liveFoe = 0;
      for (const i of ARMOUR) {
        if (sg[L.O_UNITS + Math.imul(i, L.U_WORDS) + L.U_STATE] === 0) continue;
        if (T.teamOf(i).side === side) liveOwn++; else liveFoe++;
      }
      a11geom.push({ seed: curSeed, sd: String(side), team, own: own | 0, foe: foe | 0, liveOwn, liveFoe,
        slotX: M(px), seamZ: M(pz), seamG: M(gSeam), sampleG: M(gS),
        slope: (M(gS) - M(gSeam)) / 40,                 // metres of rise per metre of x, over the 40 m sample
        depthBelow: M(gSeam) - M(hg),                   // how far the hull stands below the seam it holds
        d3, past46: d3 > 46 });
    }
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
  curSeed = seed;
  const st = init(seed), s = st.i32;
  curSt = st;
  pushWasSq.clear(); pushMovedAt.clear();
  o1onWas.clear(); o1since.clear();   // per seed: a tick of seed 2 is not a lag since seed 1
  const alive = (i) => s[base(i) + L.U_STATE] !== 0;
  add('13a seeds'); if (T.slotOrder(s[L.O_TACTICS], -1).join() !== T.slotOrder(s[L.O_TACTICS], 1).join()) add('13a orders differ');
  const lastDir = new Map(), lastFlip = new Map(), prevPost = new Map();
  const w10 = { '-1': 0, '1': 0 };
  const w60 = () => ({ own: { '-1': 0, '1': 0 }, ticks: { '-1': 0, '1': 0 },
    cross: { '-1': 0, '1': 0 }, crossKind: { '-1': {}, '1': {} },
    maxPush: { '-1': -1e9, '1': -1e9 }, at24: { '-1': 0, '1': 0 }, give: { '-1': 0, '1': 0 }, lost: { '-1': 0, '1': 0 }, full: { '-1': true, '1': true }, contact: { '-1': false, '1': false }, menLost: { '-1': 0, '1': 0 }, menIn: { '-1': 0, '1': 0 } });
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
    curTick = tick;
    const liveT = ARMOUR.filter(alive), liveM = RIFLES.filter(alive);
    const mvOf = (i) => { const q = pre.get(i); return q ? Math.hypot(s[base(i)] - q[0], s[base(i) + 1] - q[1]) / ONE : 0; };

    // ================= ARMOUR =================
    // ON THE LINE = within 40 m of its post AND not a column. A column (RULED 2026-09-16 21:20) is a tank that has
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
      // RULED (2026-09-16): the share of seam-metre samples covered by >= 2, not a tick-union.
      // RULED 2026-09-19: the two-gun bar is read AT FULL STRENGTH, which is the qualifier §4.1's own kill-zone
      // sentence carries and this row had dropped ("a side at full strength"). The row admitted any side with >= 6
      // alive and then asked the kill zone to be double-covered anyway. Measured, the shortfall is monotonic in
      // attrition and nothing else: 2.00% at twelve hulls, 9.70% at ten or eleven, 25.05% at eight or nine, 33.20%
      // at six or seven. A 46 m gun on a 27 m pitch covers 163 m of seam twice over with twelve hulls and
      // arithmetically cannot with six, so below full strength the row was asking for something no lever in the
      // spec can give. A thinned army leaving holes in its kill zone IS losses biting (§0.1, §3's supply); a row
      // that forbade it would forbid attrition from mattering. At any strength the ONE-gun floor still holds: the
      // line thins, it never goes blind, and that is what breaks if a pitch, a reach or a depth is ever moved.
      // The seam's own climb was the first hypothesis and it is only a secondary effect: at 0.6-0.9 m/m the
      // shortfall is 20.94% against 9.72% on the flattest ground, so the climb roughly doubles it - but the
      // flattest ground is still 9.72% and the full-strength bar is met across every stretch, so the climb was
      // never the cause. Recorded because it was measured, not because it carried the ruling.
      for (let xm = -81; xm <= 81; xm++) { const zx = seamOfCore(st, xm * ONE); let n = 0;
        for (const i of ls) if (Math.hypot(s[base(i)] - xm * ONE, s[base(i) + 1] - zx) < 46 * ONE) n++;
        const climb = Math.abs(seamOfCore(st, (xm + 1) * ONE) - zx) / ONE;
        if (ls.length >= 12) { add('A9 full samples'); if (n < 2) add('A9 full gap'); }
        add('A9 floor samples'); if (n < 1) add('A9 floor gap');
        const steep = climb > 0.40;
        if (steep) { add('A9 steep samples'); if (n < 1) add('A9 steep gap'); }
        else { add('A9 flat samples'); if (n < 2) add('A9 flat gap'); }
        if (A9WHY) { const b = climb < 0.1 ? '0.0-0.1' : climb < 0.2 ? '0.1-0.2' : climb < 0.3 ? '0.2-0.3'
            : climb < 0.4 ? '0.3-0.4' : climb < 0.6 ? '0.4-0.6' : climb < 0.9 ? '0.6-0.9' : '0.9+';
          add(`A9 climb ${b} samples`); if (n < 2) add(`A9 climb ${b} gap2`); if (n < 1) add(`A9 climb ${b} gap1`);
          // THE COMPETING HYPOTHESIS: not the climb at all but how many hulls that side has left. A 46 m gun and a
          // 27 m pitch cover 163 m of seam twice over at twelve hulls; at the row's own floor of six they cannot.
          const av = ls.length >= 12 ? '12' : ls.length >= 10 ? '10-11' : ls.length >= 8 ? '8-9' : '6-7';
          add(`A9 alive ${av} samples`); if (n < 2) add(`A9 alive ${av} gap2`); if (n < 1) add(`A9 alive ${av} gap1`);
          const e = Math.abs(xm) >= 65 ? 'edge 65-81' : Math.abs(xm) >= 45 ? 'mid 45-65' : 'inner <45';
          add(`A9 ${e} samples`); if (n < 2) add(`A9 ${e} gap2`);
          if (!steep) { add('A9 flat samples (why)'); if (n < 2) { add(`A9 flat gap at ${e}`); } } }
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
    // §0's READING RULE, applied to the hold row (RULED 2026-09-19): "On the line = a living tank within 40 m (z) of
    // its post. A hull further than that - a respawn walking in from the back edge - is a column." §0 already excluded
    // columns from rows 2, 4b and 7; the hold row had been counting them, so on a bloody seed it measured attrition
    // rather than holding. §3's entry is untouched: the column still walks in, it is just not evidence about the line.
    const onLineTank = (i) => { const [, hz] = holdOf(i); return Math.abs(s[base(i) + 1] - hz) <= 40 * ONE; };
    for (const i of liveT) { const j = T.partnerOf(i); if (j < 0 || !alive(j)) continue;
      add('H1 pair tank-ticks (columns included)');
      if (!onLineTank(i) || !onLineTank(j)) { add('H1 column tank-ticks (excluded)'); continue; }
      add('H1 pair tank-ticks');
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
      // THE RIDGE CAP, PRICED (2026-09-19). `goalOf` gives RIDGE's own lane a ceiling of 16 m where every ordinary
      // lane may reach 24 (PUSH_MAX), so one of the three lanes the row averages over is capped 8 m BELOW the ground
      // it is compared against. Each team-tick is tagged with which of the three it is and the ceiling it sat under,
      // so the row's 6 m difference can be split into what the cap costs and what is left.
      if (O1RIDGE) {
        const slot = s[L.O_TACTICS + T.TAC_SLOT + w];
        const lt = T.laneTerms(s, L.O_TACTICS, w < 6 ? -1 : 1, slot);
        const group = !on ? 'the rest' : slot === lanes[0] ? "RIDGE's lane" : 'the other two lanes';
        const g = (o1ridge[group] = o1ridge[group] || { n: 0, push: 0, ceil: 0, at16: 0, atCeil: 0, rest: 0 });
        g.n++; g.push += pu; g.ceil += lt.ceiling / ONE; g.rest += lt.rest / ONE;
        if (Math.abs(lt.ceiling / ONE - 16) < 0.01) g.at16++;
        if (Math.abs(pu - lt.ceiling / ONE) < 0.01) g.atCeil++;
        // THE STEPPING LAG (§4.11, ruled 2026-09-19 to keep stepping): a lane that has just become an objective gets a
        // rest of +8 but must WALK there in 8 m steps on the same 5 s clock the objective moves on. Timed from the
        // tick the lane becomes an objective to the tick its push first reaches that rest - and counted as never
        // arriving if the lane stops being an objective first.
        const wasOn = o1onWas.get(w);
        o1onWas.set(w, on);
        if (on && wasOn === false) o1since.set(w, tick);
        if (!on && wasOn === true) {
          const t0 = o1since.get(w);
          if (t0 !== undefined) { o1lag.lost++; o1lag.lostTicks += tick - t0; o1since.delete(w); }
        }
        if (on && o1since.has(w) && pu >= lt.rest / ONE - 0.01) {
          o1lag.reached++; o1lag.ticks += tick - o1since.get(w); o1since.delete(w);
        }
        if (on) { o1lag.laneTicks++; if (pu < lt.rest / ONE - 0.01) { o1lag.belowRest++; o1lag.deficit += lt.rest / ONE - pu; } }
      }
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
    if (A11AWHY) {
      for (const i of liveT) {
        const sd = String(sideOf(i));
        const p = T.postOf(s, L.O_TACTICS, i, tick);
        if ((s[base(i) + 1] - seamOfCore(st, p.x)) * sideOf(i) >= 0) continue;
        const br = branchNow.get(i) || 'none';
        const kind = p.depth < 0 ? 'pushed post'
          : br === 'crossing' ? 'scoot in x'
          : (br === 'backoff' || br === 'heldAfterGiving') ? 'gave ground'
          : (br === 'walking' || br === 'arriving') ? 'bound overshoot'
          : `other (${br})`;
        a11aKind[kind] = (a11aKind[kind] || 0) + 1;
        win.crossKind[sd][kind] = (win.crossKind[sd][kind] || 0) + 1;
      }
      for (let w = 0; w < 12; w++) {
        const sd = w < 6 ? '-1' : '1';
        const pu = s[L.O_TACTICS + T.TAC_PUSH + w];
        if (pu > win.maxPush[sd]) win.maxPush[sd] = pu;
        if (pu >= Math.imul(24, ONE)) win.at24[sd]++;
      }
    }
    const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    add('A13b ticks'); if (Math.abs(mean(push['-1']) - mean(push['1'])) >= 4) add('A13b differ');
    for (const sd of [-1, 1]) {
      const n = liveT.filter((i) => sideOf(i) === sd).length; add('A12b side-ticks'); if (n < 4) add('A12b below 4');
      // A11a's outnumbered clause: the side's own living roster over the window, against its enemy's. Measured at the
      // roster because that is what §4.10's `own`/`foe` counts track - the failing windows ran 8.48 against 11.25.
      win.own[String(sd)] += n; win.ticks[String(sd)]++;
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
    // 2026-09-16), which is the anchor he stands on - not the squad drawn at his own spawn.
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
      // B3, RULED 2026-09-19, THE POPULATION FIRST. §11.1's row says "a side's men ON POST", and §11.1's own body
      // uses that word for where a man IS ("whenever a man is on post AND his fire team's clock says halt") - two
      // conditions, not one. The probe had implemented it as `dx === 0 && dz === 0`, which is §11.2's HALT clock,
      // and §11.2 halts a fire team 0.4-1.8 s out of every 3-11 s. So the row was measuring the spread of whichever
      // 8.3 of the side's 30.1 men on the line happened to be mid-halt on that tick, and a spread of eight men drawn
      // from three squads is tight whatever the line is doing. Measured, same run, same seeds:
      //     men counted per side-tick   8.3 -> 30.1      x out of 20-60 m   61.21% -> 25.84%
      //     x under a 10 m sd          46.48% -> 9.02%   (the layout alone gives about 3%)
      // The population is every living man of the side ON THE LINE (§0's reading rule, §12.1's 40 m trail clamp):
      // a man walking to his post is still part of the line's shape; a man 40 m behind the seam cannot be on any
      // legal post and is a column (§10).
      // THE CUT IS §12.1's 40 m, which is the number the row's own text names ("§12.1's 40 m trail clamp"). The
      // probe had 44 with nothing writing it down. Measured both on one run before changing it: at 44 m the row
      // reads z 22.58% and x 18.91%; at 40 m it reads z 18.75% and x 19.49%. It moves a red number in both
      // directions, which is why it is recorded here rather than quietly taken - the band is untouched and only the
      // population's own ruled edge moves onto the metre the rule states.
      const on = liveM.filter((i) => sideOf(i) === sd
        && (s[base(i) + 1] - seamOfCore(st, s[base(i)])) * -sd / ONE >= -40);
      if (on.length < 6) continue;
      const zs = on.map((i) => (s[base(i) + 1] - seamOfCore(st, s[base(i)])) / ONE), xs = on.map((i) => s[base(i)] / ONE);
      const sdev = (a2) => { const m = mean(a2); return Math.sqrt(mean(a2.map((v) => (v - m) * (v - m)))); };
      add('B3 side-ticks'); const zsd = sdev(zs), xsd = sdev(xs);
      // z, PER SQUAD, which is §11.1's own scope: the standoff scatter it writes is per man inside a squad, while
      // the differences BETWEEN squads are §12.1's push doing its job. A side-wide sd added the two together.
      // The band 4-12 m was the standoff's own RANGE (RIFLE_STANDOFF 4 + RIFLE_SPREAD 8, "so 4 to 12") copied onto
      // a STANDARD DEVIATION: the sd that generator makes is 2.98 m and 4.52 m on the two sides with nobody dead.
      for (let sq = 0; sq < L.SQUADS_PER_SIDE; sq++) {
        const mine = on.filter((i) => squadOf(i) === sq); if (mine.length < 4) continue;
        // §12.1 gives a squad two re-reads - 600 ticks - to bring its line to a push that moved. RULED 2026-09-19:
        // a squad inside that window is in transit the spec itself licenses and is not counted on those ticks. A
        // squad still out of band AFTER its 10 s is a fault and counts.
        const key = `${sd}:${sq}`;
        const pushNow = T.pushNear(s, L.O_TACTICS, sd, s[L.O_SQUADS + (sd < 0 ? 0 : L.SQUADS_PER_SIDE) + sq]);
        if (pushWasSq.get(key) !== pushNow) { pushWasSq.set(key, pushNow); pushMovedAt.set(key, tick); }
        const movedAt = pushMovedAt.get(key);
        if (movedAt !== undefined && tick - movedAt < 600) { add('B3 z in §12.1 transit'); continue; }
        const zq = sdev(mine.map((i) => (s[base(i) + 1] - seamOfCore(st, s[base(i)])) / ONE));
        add('B3 squad z-ticks'); if (zq < 2 || zq > 12) add('B3 z out');
        if (B3SPLIT) {
          const still = mine.filter((i) => { const u = hk.unit.get(i); return u && u.dx === 0 && u.dz === 0; });
          const zh = still.length >= 4 ? sdev(still.map((i) => (s[base(i) + 1] - seamOfCore(st, s[base(i)])) / ONE)) : null;
          b3z.push({ seed, sd, sq, zq, men: mine.length, halted: still.length, zHalted: zh, tight: zq < 2, loose: zq > 12 });
        } }
      // x, RELATIVE TO THE FRONTAGE THE SIDE WAS GIVEN. The absolute 20 m floor was a bar on a DRAW: three squad
      // anchors uniform on [-80, +80] (sim.js), a man within +-8 m of his, and over 200k draws the men's sd lands
      // below 20 m on 19.6% of rounds before a shot is fired. With the population corrected the measured rate is
      // 25.8% against that predicted 19.6%, so the floor is very largely the draw and not the infantry. The bar is
      // therefore the part the infantry controls - do the men cover the frontage their own anchors span - and it
      // still fails a side that abandons a flank.
      // x's REFERENCE FRONTAGE, RULED 2026-09-19 (third correction of this row): a wiped squad holds no frontage,
      // so the floor is measured from the anchors of the squads that still have a living man. Nothing in §8-§12
      // sends the survivors sideways to cover its ground - that is the parked whole-line movement item (§15) - and
      // §10 refills the squad by walking replacements in, so the gap is a temporary fact of attrition.
      const liveSquads = [0, 1, 2].filter((k) => on.some((i) => squadOf(i) === k));
      const anch = liveSquads.map((k) => s[L.O_SQUADS + (sd < 0 ? 0 : L.SQUADS_PER_SIDE) + k] / ONE);
      const anchSd = anch.length > 1 ? sdev(anch) : 0;
      add('B3 x-ticks'); if (xsd < 0.6 * anchSd || xsd > 60) add('B3 x out');
      if (B3SPLIT) {
        // AND WHERE THE LINE THE CORE WRITES ACTUALLY IS. A rifleman's post is his squad's anchor plus a fixed
        // offset of +-9 m (army.js riflePost, SQUAD_OFFSET 18), so if the men stood on their posts the men's x sd
        // would track the anchors' own sd. It measures 12.9 m against an anchor sd of 46.8 on failing ticks, which
        // can only mean the men are not on them. This prints the posts' spread beside the men's, and how far each
        // man is from his own, so the fix lands on whichever of the two is wrong.
        const postX = on.map((i) => T2.riflePost(s[L.O_SQUADS + (sd < 0 ? 0 : L.SQUADS_PER_SIDE) + squadOf(i)], i) / ONE);
        const off = on.map((i, k) => Math.abs(s[base(i)] / ONE - postX[k]));
        // WHICH SQUADS STILL HAVE MEN. The floor is 0.6 x the sd of the side's THREE anchors, but the men counted
        // are the living ones, and a squad that has been wiped leaves its anchor in the floor with nobody to stand
        // on it. So the anchors of the squads that still have a living man are measured beside all three.
        const liveSq = [0, 1, 2].filter((q) => on.some((i) => squadOf(i) === q));
        const anchLive = liveSq.map((q) => s[L.O_SQUADS + (sd < 0 ? 0 : L.SQUADS_PER_SIDE) + q] / ONE);
        b3x.push({ seed, sd, xsd, anchSd, floor: 0.6 * anchSd, men: on.length,
          liveSquads: liveSq.length, anchLiveSd: anchLive.length > 1 ? sdev(anchLive) : 0,
          under: xsd < 0.6 * anchSd, over: xsd > 60, underOld20: xsd < 20,
          postSd: sdev(postX), offMean: mean(off), offMax: Math.max(...off),
          offOver5: off.filter((v) => v > 5).length / off.length });
      }
      if (xsd < 10) add('B3 x under 10 m sd');
      b3OutNow.set(sd, (zsd < 2 || zsd > 12 || xsd < 0.6 * anchSd || xsd > 60));
      // BEFORE AND AFTER IN ONE RUN (2026-09-19). The population correction's before/after has been quoted from two
      // runs taken across a code change, which is how three other figures in this letter went stale. So both
      // populations are measured on the SAME tick here: the old one - men whose own step was zero, which is §11.2's
      // halt clock - and the ruled one, every living man of the side on the line. Same bands, same seeds, one pass.
      if (B3POP) {
        const halted = on.filter((i) => { const u = hk.unit.get(i); return u && u.dx === 0 && u.dz === 0; });
        // and the same line population cut at §12.1's stated 40 m rather than the 44 the probe uses, because a
        // published before/after for this row does not reproduce and the cut is the one thing that differs.
        const line40 = liveM.filter((i) => sideOf(i) === sd
          && (s[base(i) + 1] - seamOfCore(st, s[base(i)])) * -sd / ONE >= -40);
        for (const [tag, pop] of [['halted', halted], ['line', on], ['line40', line40]]) {
          if (pop.length < 6) continue;
          const px = pop.map((i) => s[base(i)] / ONE);
          const pxsd = sdev(px);
          add(`B3POP ${tag} side-ticks`); add(`B3POP ${tag} men`, pop.length);
          if (pxsd < 20 || pxsd > 60) add(`B3POP ${tag} x out of the old 20-60 band`);
          if (pxsd < 0.6 * anchSd || pxsd > 60) add(`B3POP ${tag} x out of the ruled floor`);
          if (pxsd < 10) add(`B3POP ${tag} x under a 10 m sd`);
          for (let sq = 0; sq < L.SQUADS_PER_SIDE; sq++) {
            const mine = pop.filter((i) => squadOf(i) === sq); if (mine.length < 4) continue;
            const zq = sdev(mine.map((i) => (s[base(i) + 1] - seamOfCore(st, s[base(i)])) / ONE));
            add(`B3POP ${tag} squad z-ticks`); if (zq < 2 || zq > 12) add(`B3POP ${tag} z out of 2-12`);
            if (zq < 4 || zq > 12) add(`B3POP ${tag} z out of the old 4-12`); }
        }
      }
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
    // RULED 2026-09-19: 1200 ticks, not 600. The 10 s window was arithmetic under the 6-10 s leg the row was written
    // against; the 20:30 re-ruling doubled the leg to 12-20 s and the scoot cool-down to 20 s and left the window
    // behind, so nothing obliged a change inside it any more and what held the row up was six teams' phases, i.e. luck.
    if ((t + 1) % 1200 === 0) { for (const sd of ['-1', '1']) { add('A4a windows'); if (w10[sd] === 0) add('A4a still');
      if (CAUSE) add(`A4a changes ${w10[sd] === 0 ? '0' : w10[sd] <= 2 ? '1-2' : w10[sd] <= 6 ? '3-6' : '7+'}`);
      if (A4AWHY) {
        const mine = ARMOUR.filter((i) => String(sideOf(i)) === sd);
        const live = mine.filter(alive);
        const bounding = live.filter((i) => T.isBounding(s, L.O_TACTICS, i, tick)).length;
        const teams = sd === '-1' ? [0, 1, 2, 3, 4, 5] : [6, 7, 8, 9, 10, 11];
        a4aWindows.push({ seed, sd, from: t + 1 - 1200, to: t + 1, changes: w10[sd], live: live.length, bounding,
          scoot: teams.map((w) => s[L.O_TACTICS + T.TAC_SCOOT + w]).join('/'),
          slot: teams.map((w) => s[L.O_TACTICS + T.TAC_SLOT + w]).join('/') });
      }
      w10[sd] = 0; } }
    if ((t + 1) % 3600 === 0) {
      for (const sd of ['-1', '1']) {
        add('A11 windows'); if (win.cross[sd] === 0) add('A11a no crossing'); if (win.give[sd] === 0) add('A11b no giving');
        // THE RESTATED ROW (RULED 2026-09-19), three parts, all counted here:
        //  (a) some side crossed in this window - a window in which NEITHER side crossed is a static front;
        //  (b) a side that did not cross was outnumbered while it did not - §4.10's give-ground branch working;
        //  (c) no side goes a whole run without crossing anywhere.
        { const k = `${seed}:${sd}`; if (win.cross[sd] > 0) everCross[k] = true; else if (!(k in everCross)) everCross[k] = false;
          const mine = win.ticks[sd] ? win.own[sd] / win.ticks[sd] : 0;
          const theirs = win.ticks[String(-Number(sd))] ? win.own[String(-Number(sd))] / win.ticks[String(-Number(sd))] : 0;
          if (win.cross[sd] === 0) { add('A11a windows a side did not cross');
            if (mine < theirs) add('A11a not crossing while outnumbered'); else add('A11a not crossing at parity or ahead'); } }
        // WHY THE WINDOW WAS SHORT, with the instrument already here: no step of that kind at all, or steps that were
        // taken and still did not carry a team across the seam / below zero inside the window.
        if (CAUSE) {
          if (win.cross[sd] === 0) add((winSteps.take[sd] || 0) === 0 ? 'A11a no take step at all' : 'A11a took steps but no crossing');
          if (win.give[sd] === 0) add((winSteps.give[sd] || 0) === 0 ? 'A11b no give step at all' : 'A11b gave steps but none below zero');
        }
        if (A11AWHY) a11aWindows.push({ seed, sd, to: t + 1, cross: win.cross[sd], kinds: { ...win.crossKind[sd] },
          maxPush: win.maxPush[sd] / ONE, at24: win.at24[sd], takeSteps: winSteps.take[sd] || 0 });
        winSteps.give[sd] = 0; winSteps.take[sd] = 0;
        if (win.full[sd] && win.lost[sd] === 0 && win.contact[sd]) add('A12a full lossless');
        if (sd === '1' && win.cross['-1'] === 0 && win.cross['1'] === 0) add('A11a no side crossed');
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
    // WHAT A MISS ACTUALLY WAS (2026-09-19). The row reads "the squad did not follow", but four different things
    // produce that verdict and only one of them is the infantry. The squad snapshot above holds men who are STANDING
    // STILL this tick, so a squad still walking is absent from it entirely: a miss with almost no readings is a squad
    // that never stood, not a squad that stood in the wrong place. Counted here, not guessed.
    if (B4WHY) {
      const end = Math.min(pushHist.length, t + 600);
      let seen = 0, best = -Infinity, men = 0, changedAgain = false, reversed = false;
      for (let u = t; u < end; u++) {
        const f = pushHist[u].get(k); if (!f) continue;
        seen++; men += f.z.length;
        const got = (mean(f.z) - z0) * Math.sign(want);
        if (got > best) best = got;
        // and WHICH WAY it moved again: a push that comes back toward where it started asks the squad for nothing,
        // which is a different thing from a squad that would not go.
        if (f.push !== e.push) { changedAgain = true;
          if ((f.push - e.push) / ONE * Math.sign(want) < 0) reversed = true; }
      }
      const need = Math.abs(want) / 2;
      const frac = best === -Infinity ? null : best / need;
      b4rows.push({ seed, k, want, need, seen, ticks: end - t, men: seen ? men / seen : 0, frac, changedAgain, reversed, ok });
    }
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
  ['A4a 20 s windows with no post change on a side', `${r['A4a still'] || 0} of ${r['A4a windows']}`, (r['A4a still'] || 0) === 0],
  ['A4b ticks with > half the line moving', P(pct('A4b over half', 'A4b side-ticks')), pct('A4b over half', 'A4b side-ticks') <= 0.02],
  ['A5  both of a pair bounding / gap not 14 m', `${r['A5 both bounding'] || 0} / ${r['A5 gap not 14 m'] || 0}`, !(r['A5 both bounding'] || r['A5 gap not 14 m'])],
  ['A6  scoot missed with a free slot beside', `${r['A6 missed'] || 0} (moved ${r['A6 moved'] || 0}, hemmed ${r['A6 hemmed'] || 0})`, (r['A6 missed'] || 0) === 0],
  ['A7  holding hulls on the line facing the enemy', P(pct('A7 facing', 'A7 holding')), pct('A7 facing', 'A7 holding') > 0.95],
  ['A8  slot changes not exactly 27 m', `${r['A8 not 27 m'] || 0}`, (r['A8 not 27 m'] || 0) === 0],
  ['A9  seam metres covered by < 2, AT FULL STRENGTH (§4.1)', `${P(pct('A9 full gap', 'A9 full samples'))} of ${r['A9 full samples'] || 0}`, pct('A9 full gap', 'A9 full samples') <= 0.05],
  ['A9  seam metres covered by < 1, at any strength (the floor)', `${P(pct('A9 floor gap', 'A9 floor samples'))} of ${r['A9 floor samples'] || 0}`, pct('A9 floor gap', 'A9 floor samples') <= 0.05],
  ['A9  (old bar: two guns at >= 6 alive, information only)', P(pct('A9 gap', 'A9 samples')), true],
  ['A10 posts differing with the truck parked vs driven', `${r['X10 differ']} of ${r['X10 compared']}`, r['X10 differ'] === 0],
  ['A11a 60 s windows in which NEITHER side crossed the seam', `${r['A11a no side crossed'] || 0} of ${(r['A11 windows'] || 0) / 2}`, (r['A11a no side crossed'] || 0) === 0],
  ['A11a a side that did not cross, and was not outnumbered', `${r['A11a not crossing at parity or ahead'] || 0} of ${r['A11a windows a side did not cross'] || 0} such windows`
    + ` (outnumbered ${r['A11a not crossing while outnumbered'] || 0})`, (r['A11a not crossing at parity or ahead'] || 0) === 0],
  // THIS CLAUSE NEEDS MORE THAN ONE WINDOW TO SAY ANYTHING. At TICKS = 3600 each side-run holds exactly one 60 s
  // window, so "crossed in no window of its run" is the window clause restated and fails by construction with it.
  // It is asserted only on a run long enough to have a second window, and says so otherwise.
  ['A11a a side that crossed in no window of its whole run',
    TICKS >= 7200 ? `${Object.values(everCross).filter((v) => !v).length} of ${Object.keys(everCross).length} side-runs`
                  : `not asserted at ${TICKS} ticks (one window a side-run; needs >= 7200)`,
    TICKS < 7200 || Object.values(everCross).every((v) => v)],
  ['A11b 60 s windows with no team giving ground', `${r['A11b no giving'] || 0} of ${r['A11 windows']}`, (r['A11b no giving'] || 0) === 0],
  ['A11c team-ticks off the 16 m default', P(pct('A11c off default', 'A11c team-ticks')), pct('A11c off default', 'A11c team-ticks') > 0.3],
  ['A12a side full and lossless 60 s in contact', `${r['A12a full lossless'] || 0}`, (r['A12a full lossless'] || 0) === 0],
  ['A12b side below 4 tanks', P(pct('A12b below 4', 'A12b side-ticks')), pct('A12b below 4', 'A12b side-ticks') <= 0.05],
  ['A13a slot orders differ', `${r['13a orders differ'] || 0} of ${r['13a seeds']}`, r['13a orders differ'] === r['13a seeds']],
  ['A13b sides\' mean push differs >= 4 m', P(pct('A13b differ', 'A13b ticks')), pct('A13b differ', 'A13b ticks') > 0.5],
  ['H1  pair tank-ticks within 1.5 m of the hold (columns out)',
    `${P(pct('H1 on post', 'H1 pair tank-ticks'))} of ${r['H1 pair tank-ticks'] || 0}`
    + ` (columns excluded ${r['H1 column tank-ticks (excluded)'] || 0} of ${r['H1 pair tank-ticks (columns included)'] || 0})`,
    pct('H1 on post', 'H1 pair tank-ticks') >= 0.5],
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
  // O4 is the CLIENT's row and this probe cannot run it: the test lives in packages/arena-client
  // (test/objective-markers.test.js) and drives a real page. Its verdict is not invented here - this row says where
  // the answer comes from, and stays red in this table so nobody reads a core run as having answered it.
  ['O4  client draws the markers (arena-client test/objective-markers.test.js, not this probe)',
    'run it there - passing on 0.0.1659', false],
  ['O5  objective words differing, truck parked vs driven', `${r['O5 differ']} of ${r['O5 compared']}`, r['O5 differ'] === 0],
  ['M1  lead/trend/momentum differing, truck parked vs driven', `${r['M1 differ']} of ${r['M1 compared']}`, r['M1 differ'] === 0],
  ['M1  lead/trend/momentum differing, two players (seeds) on the same samples', `${r['M1 across differ']} of ${r['M1 across']}`, r['M1 across differ'] === 0],
  ['S1  side holding more objectives has more living tanks', P(pct('S1 more tanks', 'S1 uneven ticks')), pct('S1 more tanks', 'S1 uneven ticks') >= 0.55],
  ['S2  side with 2+ objectives lost below 4 tanks', P(pct('S2 below 4', 'S2 down two')), pct('S2 below 4', 'S2 down two') <= 0.08],
  ['B1  man within 18 m of a fire-team mate', P(pct('B1 near a mate', 'B1 man-ticks')), pct('B1 near a mate', 'B1 man-ticks') > 0.8],
  ['B1  fire team moves or halts together', P(pct('B1b together', 'B1b team-ticks')), pct('B1b together', 'B1b team-ticks') > 0.9],
  ['B2  5 s squad windows without a halted team / a mover', `${r['B2 fail'] || 0} of ${r['B2 squad-windows']}`, (r['B2 fail'] || 0) === 0],
  ['B3  z spread per squad in 2-12 m on > 80% of squad-ticks (B1 tolerance)', `${P(pct('B3 z out', 'B3 squad z-ticks'))} of ${r['B3 squad z-ticks'] || 0} squad-ticks`
    + ` (${r['B3 z in §12.1 transit'] || 0} inside §12.1's 10 s not counted)`,
    pct('B3 z out', 'B3 squad z-ticks') <= 0.20],
  ['B3  x spread in band on > 80% of side-ticks (0.6 x LIVING squads\' anchors, ceiling 60 m)', `${P(pct('B3 x out', 'B3 x-ticks'))} of ${r['B3 x-ticks'] || 0} side-ticks`
    + ` (under a 10 m sd on ${P(pct('B3 x under 10 m sd', 'B3 x-ticks'))})`,
    pct('B3 x out', 'B3 x-ticks') <= 0.20],
  ['B4  push changes the squad did not follow in 10 s', `${r['B4 did not follow'] || 0} of ${r['B4 changes'] || 0}`, (r['B4 did not follow'] || 0) === 0],
  ['B5  man-ticks inside 3 m of a tank', P(pct('B5 inside a hull', 'B5 man-ticks')), pct('B5 inside a hull', 'B5 man-ticks') <= 0.005],
  ['B6  60 s windows with < 3 men lost or arrived / arrivals on the line', `${r['B6 fail'] || 0} of ${r['B6 windows']} / ${r['B6 appeared on the line'] || 0} of ${r['B6 arrivals'] || 0}`, !(r['B6 fail'] || r['B6 appeared on the line'])],
];
// --dump=<prefix>: every raw counter whose name starts with the prefix, for a diagnostic that has no print of its own.
{ const d = arg('dump', null);
  if (d !== null) { console.log(`--- raw counters, prefix ${JSON.stringify(d)} ---`);
    for (const k of Object.keys(r).sort()) if (k.startsWith(d)) console.log(`  ${k.padEnd(46)} ${r[k]}`); } }
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
if (O1RIDGE) {
  const G = (k) => o1ridge[k] || { n: 0, push: 0, ceil: 0, at16: 0, atCeil: 0, rest: 0 };
  const ridge = G("RIDGE's lane"), other = G('the other two lanes'), rest = G('the rest');
  const mean = (g, f) => g.n ? f(g) / g.n : NaN;
  console.log(`O1's mean push, split by which lane and the ceiling it sat under:`);
  for (const [label, g] of [["RIDGE's lane   ", ridge], ['the other two   ', other], ['the rest        ', rest]])
    console.log(`  ${label} n ${String(g.n).padStart(6)}  mean push ${mean(g, (x) => x.push).toFixed(2).padStart(6)} m  `
      + `mean ceiling ${mean(g, (x) => x.ceil).toFixed(1).padStart(5)} m  mean rest ${mean(g, (x) => x.rest).toFixed(2).padStart(5)} m  `
      + `capped at 16 ${(100 * g.at16 / Math.max(g.n, 1)).toFixed(1)}%  sitting ON its ceiling ${(100 * g.atCeil / Math.max(g.n, 1)).toFixed(1)}%`);
  const onN = ridge.n + other.n, onPush = ridge.push + other.push;
  const meanOn = onPush / Math.max(onN, 1), meanRest = mean(rest, (x) => x.push);
  const shown = meanOn - meanRest;
  const withoutRidge = mean(other, (x) => x.push) - meanRest;
  console.log(`  the row as it stands: ${meanOn.toFixed(2)} - ${meanRest.toFixed(2)} = ${shown.toFixed(2)} m against a 6 m bar`);
  console.log(`  the same difference counting only the two UNCAPPED objective lanes: ${withoutRidge.toFixed(2)} m`);
  console.log(`  so RIDGE's 16 m cap costs the row ${(withoutRidge - shown).toFixed(2)} m of its difference`);
  const gap = 6 - shown, unheld = 0.73;
  console.log(`  that is ${(100 * (withoutRidge - shown) / gap).toFixed(1)}% of the ${gap.toFixed(2)} m live shortfall`);
  // WHERE THE DIFFERENCE GOES, in the row's own terms: what the rules PRICE a lane above the rest, minus what each
  // group gives back by not sitting at its own rest.
  const priced = mean(ridge, (x) => x.rest) * ridge.n / Math.max(onN, 1) + mean(other, (x) => x.rest) * other.n / Math.max(onN, 1);
  console.log(`  the rules price a lane ${priced.toFixed(2)} m of rest against the rest's ${mean(rest, (x) => x.rest).toFixed(2)} m; `
    + `lanes sit ${(priced - meanOn).toFixed(2)} m BELOW their own rest and the rest sits `
    + `${(meanRest - mean(rest, (x) => x.rest)).toFixed(2)} m ABOVE its own`);
  console.log(`  RIDGE's lane sits ${(mean(ridge, (x) => x.rest) - mean(ridge, (x) => x.push)).toFixed(2)} m below its rest, `
    + `the other two ${(mean(other, (x) => x.rest) - mean(other, (x) => x.push)).toFixed(2)} m below theirs`);
  console.log(`O1's stepping lag: a lane reached its +8 rest ${o1lag.reached} times, taking a mean `
    + `${(o1lag.ticks / Math.max(o1lag.reached, 1) / 60).toFixed(1)} s; it stopped being an objective before reaching it `
    + `${o1lag.lost} times, after a mean ${(o1lag.lostTicks / Math.max(o1lag.lost, 1) / 60).toFixed(1)} s. `
    + `Lane team-ticks below their own rest ${o1lag.belowRest} of ${o1lag.laneTicks} = `
    + `${(100 * o1lag.belowRest / Math.max(o1lag.laneTicks, 1)).toFixed(1)}%, mean deficit while below `
    + `${(o1lag.deficit / Math.max(o1lag.belowRest, 1)).toFixed(2)} m`);
}
if (B4WHY) {
  const miss = b4rows.filter((r) => !r.ok), hit = b4rows.filter((r) => r.ok);
  // A miss with almost nothing sampled is a squad that never stood still inside the window; the row cannot see such a
  // squad move, so it is not evidence about following either way.
  const THIN = 60;                                   // fewer than 1 s of readings out of the 10 s window
  const kind = (r) => r.seen < THIN ? 'never stood still (unreadable)'
    : r.reversed ? 'the push came back before the 10 s were up'
    : r.changedAgain ? 'the push moved again inside the window'
    : r.frac === null || r.frac <= 0 ? 'stood and did not follow at all'
    : 'followed, but less than half';
  const by = {};
  for (const r of miss) by[kind(r)] = (by[kind(r)] || 0) + 1;
  console.log(`B4's misses, by what the miss was (${miss.length} of ${b4rows.length} push changes):`);
  for (const [k2, v] of Object.entries(by).sort((a, b) => b[1] - a[1]))
    console.log(`  ${k2.padEnd(38)} ${v} of ${miss.length}`);
  const show = (rs, label) => {
    const m = (f) => rs.length ? (rs.reduce((a, r) => a + f(r), 0) / rs.length).toFixed(2) : '-';
    console.log(`  ${label}: n ${rs.length}, mean ticks readable ${m((r) => r.seen)} of 600, mean men standing `
      + `${m((r) => r.men)}, mean push change ${m((r) => r.want)} m, mean best follow as a share of the half it `
      + `owes ${m((r) => (r.frac === null ? 0 : Math.max(-1, Math.min(2, r.frac))))}`);
  };
  show(miss, 'misses  '); show(hit, 'follows ');
  console.log(`  every miss: ` + miss.map((r) => `seed ${r.seed} ${r.k} want ${r.want.toFixed(0)}m seen ${r.seen}`
    + ` men ${r.men.toFixed(1)} best ${r.frac === null ? 'none' : r.frac.toFixed(2)}${r.changedAgain ? ' (push moved again)' : ''}`).join('; '));
}
if (A11GEOM) {
  const FAIL = new Set(['2|1', '4|1', '5|1']);
  const mean = (rs, f) => rs.length ? (rs.reduce((a, o) => a + f(o), 0) / rs.length) : NaN;
  const keys = [...new Set(a11geom.map((o) => `${o.seed}|${o.sd}`))].sort();
  console.log(`A11a's slots at the same re-reads: where they stand, what the seam does there, and the odds beside it.`);
  console.log(`  NOTE, from the code: §4.10 compares dx and dz against the 46 m reach and reads NO height, so the`);
  console.log(`  climb columns cannot enter own or foe. They are A9's quantity at these slots, printed, not coupled.`);
  console.log(`  window  n   slotX(m)  seamZ(m)  slope(m/m)  depth below seam(m)  3-D to the 40 m sample(m)  past 46 m  own  foe`);
  for (const k of keys) {
    const rs = a11geom.filter((o) => `${o.seed}|${o.sd}` === k);
    console.log(`  ${FAIL.has(k) ? '*' : ' '}${k.padEnd(6)} ${String(rs.length).padStart(3)}  `
      + `${mean(rs, (o) => o.slotX).toFixed(1).padStart(7)}  ${mean(rs, (o) => o.seamZ).toFixed(1).padStart(7)}  `
      + `${mean(rs, (o) => o.slope).toFixed(3).padStart(9)}  ${mean(rs, (o) => o.depthBelow).toFixed(2).padStart(17)}  `
      + `${mean(rs, (o) => o.d3).toFixed(1).padStart(23)}  ${String(rs.filter((o) => o.past46).length).padStart(8)}  `
      + `${mean(rs, (o) => o.own).toFixed(2)}  ${mean(rs, (o) => o.foe).toFixed(2)}`);
  }
  const grp = (want) => a11geom.filter((o) => FAIL.has(`${o.seed}|${o.sd}`) === want);
  for (const [label, rs] of [['the three failing windows', grp(true)], ['every other window    ', grp(false)]]) {
    const steep = rs.filter((o) => Math.abs(o.slope) >= 0.57).length;
    console.log(`  ${label}: n ${rs.length}, mean slope ${mean(rs, (o) => Math.abs(o.slope)).toFixed(3)} m/m, `
      + `readings on a climb of 0.57 m/m or steeper ${steep} = ${(100 * steep / rs.length).toFixed(1)}%, `
      + `mean depth below the seam ${mean(rs, (o) => o.depthBelow).toFixed(2)} m, `
      + `mean 3-D to the sample ${mean(rs, (o) => o.d3).toFixed(1)} m, past 46 m `
      + `${rs.filter((o) => o.past46).length} = ${(100 * rs.filter((o) => o.past46).length / rs.length).toFixed(1)}%, `
      + `mean own ${mean(rs, (o) => o.own).toFixed(2)} foe ${mean(rs, (o) => o.foe).toFixed(2)}`);
    console.log(`  ${label}: hulls ALIVE on the side at those same ticks ${mean(rs, (o) => o.liveOwn).toFixed(2)} `
      + `against the enemy's ${mean(rs, (o) => o.liveFoe).toFixed(2)}; share of the side's living hulls that were `
      + `inside the 46 m ${(100 * mean(rs, (o) => o.own) / mean(rs, (o) => o.liveOwn)).toFixed(1)}%, `
      + `of the enemy's ${(100 * mean(rs, (o) => o.foe) / mean(rs, (o) => o.liveFoe)).toFixed(1)}%`);
  }
}
if (A11ODDS) {
  // TAKE is `own + weight >= foe + 3`, GIVE is `foe >= own + 1 + weight` (tactics.js PUSH_TAKE_LEAD / PUSH_GIVE_LEAD).
  const FAIL = new Set(['2|1', '4|1', '5|1']);              // the three windows with no crossing
  const name = ['none', 'take', 'give', 'drift'];
  const rows = (k) => a11odds.filter((o) => `${o.seed}|${o.sd}` === k);
  const line = (k) => {
    const rs = rows(k);
    if (!rs.length) return `${k}: no odds reading was taken at all (due ${a11due[k] || 0}, past gate (a) ${a11on[k] || 0})`;
    const mean = (f) => (rs.reduce((a, o) => a + f(o), 0) / rs.length).toFixed(2);
    const takes = rs.filter((o) => !o.widow && o.own + o.weight >= o.foe + 3).length;
    const gives = rs.filter((o) => !o.widow && o.foe >= o.own + 1 + o.weight).length;
    const by = {}; for (const o of rs) by[name[o.v] || o.v] = (by[name[o.v] || o.v] || 0) + 1;
    return `${k}: due ${a11due[k] || 0}, past gate (a) ${a11on[k] || 0}, odds read ${rs.length}; `
      + `mean own ${mean((o) => o.own)} vs foe ${mean((o) => o.foe)} (own - foe ${mean((o) => o.own - o.foe)}), `
      + `mean weight ${mean((o) => o.weight)}, widow readings ${rs.filter((o) => o.widow).length}; `
      + `readings that MET take ${takes}, met give ${gives}; verdicts ${JSON.stringify(by)}`;
  };
  console.log(`A11a's odds at every re-read the core actually took (§4.10: own and foe inside 46 m of the slot centre):`);
  console.log(`  --- the three windows with no crossing ---`);
  for (const k of [...FAIL]) console.log(`  ${line(k)}`);
  console.log(`  --- every other window, for contrast ---`);
  for (const k of [...new Set(a11odds.map((o) => `${o.seed}|${o.sd}`))].filter((k) => !FAIL.has(k)).sort())
    console.log(`  ${line(k)}`);
  // and the own - foe spread on the failing side, which is the quantity TAKE is a threshold on
  const spread = (ks) => {
    const d = a11odds.filter((o) => ks.has(`${o.seed}|${o.sd}`) && !o.widow).map((o) => o.own + o.weight - o.foe).sort((a, b) => a - b);
    return d.length ? `n ${d.length}, min ${d[0]}, median ${d[d.length >> 1]}, max ${d[d.length - 1]}, `
      + `at or over the take lead of 3: ${d.filter((x) => x >= 3).length}` : 'none';
  };
  const other = new Set(a11odds.map((o) => `${o.seed}|${o.sd}`).filter((k) => !FAIL.has(k)));
  console.log(`  own + weight - foe, the quantity TAKE is a threshold on:`);
  console.log(`    failing windows: ${spread(FAIL)}`);
  console.log(`    the rest:        ${spread(other)}`);
}
if (A11AWHY) {
  const tot = Object.values(a11aKind).reduce((a, b) => a + b, 0) || 1;
  console.log(`A11a's crossings by what put the hull there (${tot} tank-ticks past the seam):`);
  for (const [k, v] of Object.entries(a11aKind).sort((a, b) => b[1] - a[1]))
    console.log(`  ${k.padEnd(18)} ${String(v).padStart(7)} = ${(100 * v / tot).toFixed(1)}%`);
  const bad = a11aWindows.filter((w) => w.cross === 0);
  console.log(`A11a's failing windows (${bad.length} of ${a11aWindows.length}), and what the side had to cross with:`);
  for (const w of bad)
    console.log(`  seed ${w.seed} side ${w.sd} to t${w.to}: crossings 0, take steps ${w.takeSteps}, highest push on `
      + `the side ${w.maxPush.toFixed(0)} m, team-ticks at the 24 m ceiling ${w.at24}`);
  console.log(`A11a's passing windows, for contrast:`);
  for (const w of a11aWindows.filter((x) => x.cross > 0))
    console.log(`  seed ${w.seed} side ${w.sd} to t${w.to}: crossings ${w.cross}, highest push ${w.maxPush.toFixed(0)} m, `
      + `at 24 m ${w.at24}, by kind ${JSON.stringify(w.kinds)}`);
}
if (B3SPLIT) {
  const q = (a) => { const b = a.slice().sort((u, v) => u - v); return b.length ? [b[0], b[b.length >> 2], b[b.length >> 1], b[Math.floor(b.length * 0.75)], b[b.length - 1]] : []; };
  const F = (a) => a.map((v) => v.toFixed(1)).join(' / ');
  const xf = b3x.filter((e) => e.under || e.over), xp = b3x.filter((e) => !e.under && !e.over);
  console.log(`B3 x, split over ${b3x.length} side-ticks: ${xf.length} fail = ${(100 * xf.length / b3x.length).toFixed(2)}%`);
  console.log(`   under the 0.6 x anchor floor ${xf.filter((e) => e.under).length}, over the 60 m ceiling ${xf.filter((e) => e.over).length}`);
  console.log(`   of the failures, also under the OLD absolute 20 m floor: ${xf.filter((e) => e.underOld20).length}`
    + ` = ${(100 * xf.filter((e) => e.underOld20).length / Math.max(xf.length, 1)).toFixed(1)}%; the rest fail ONLY because their own anchors were wide`);
  console.log(`   anchor sd (min/q1/med/q3/max)  failing ${F(q(xf.map((e) => e.anchSd)))}   passing ${F(q(xp.map((e) => e.anchSd)))}`);
  console.log(`   men's x sd                     failing ${F(q(xf.map((e) => e.xsd)))}   passing ${F(q(xp.map((e) => e.xsd)))}`);
  console.log(`   the floor those anchors imply  failing ${F(q(xf.map((e) => e.floor)))}   passing ${F(q(xp.map((e) => e.floor)))}`);
  console.log(`   the POSTS' own x sd            failing ${F(q(xf.map((e) => e.postSd)))}   passing ${F(q(xp.map((e) => e.postSd)))}`);
  console.log(`   mean |man - his own post| in x failing ${F(q(xf.map((e) => e.offMean)))}   passing ${F(q(xp.map((e) => e.offMean)))}`);
  console.log(`   share of men more than 5 m off failing ${F(q(xf.map((e) => 100 * e.offOver5)))}   passing ${F(q(xp.map((e) => 100 * e.offOver5)))}`);
  console.log(`   squads with a living man       failing ${F(q(xf.map((e) => e.liveSquads)))}   passing ${F(q(xp.map((e) => e.liveSquads)))}`);
  console.log(`   sd of the LIVING squads' anchors failing ${F(q(xf.map((e) => e.anchLiveSd)))}   passing ${F(q(xp.map((e) => e.anchLiveSd)))}`);
  const wouldPass = xf.filter((e) => e.xsd >= 0.6 * e.anchLiveSd && e.xsd <= 60);
  console.log(`   of the ${xf.length} failures, ${wouldPass.length} = ${(100 * wouldPass.length / Math.max(xf.length, 1)).toFixed(1)}%`
    + ` would PASS if the floor used only the anchors of squads that still have a living man`);
  const dead = xf.filter((e) => e.liveSquads < 3);
  console.log(`   failures with a wiped squad    ${dead.length} = ${(100 * dead.length / Math.max(xf.length, 1)).toFixed(1)}% of the failures`
    + `; among passing ticks ${(100 * xp.filter((e) => e.liveSquads < 3).length / Math.max(xp.length, 1)).toFixed(1)}%`);
  const zf = b3z.filter((e) => e.tight || e.loose);
  console.log(`B3 z, split over ${b3z.length} squad-ticks: ${zf.length} fail = ${(100 * zf.length / b3z.length).toFixed(2)}%`);
  console.log(`   tighter than 2 m ${zf.filter((e) => e.tight).length}, looser than 12 m ${zf.filter((e) => e.loose).length}`);
  const withH = zf.filter((e) => e.zHalted !== null);
  const fixed = withH.filter((e) => e.zHalted >= 2 && e.zHalted <= 12);
  console.log(`   of the ${withH.length} failures with 4+ halted men, ${fixed.length} = ${(100 * fixed.length / Math.max(withH.length, 1)).toFixed(1)}%`
    + ` would be INSIDE the band counting halted men only - that share is transit depth, not the line standing wrong`);
  console.log(`   squad z sd (min/q1/med/q3/max)  failing ${F(q(zf.map((e) => e.zq)))}   halted-only there ${F(q(withH.map((e) => e.zHalted)))}`);
  console.log(`   men per squad on failing ticks ${F(q(zf.map((e) => e.men)))}, of them halted ${F(q(zf.map((e) => e.halted)))}`);
}
if (B3POP) {
  const n = (k) => r[k] || 0;
  const pc = (a, b) => (n(b) ? `${(100 * n(a) / n(b)).toFixed(2)}%` : '-');
  console.log(`B3's population, both counted on the same ticks of the same run:`);
  for (const tag of ['halted', 'line', 'line40']) {
    const st2 = n(`B3POP ${tag} side-ticks`);
    console.log(`  ${tag === 'halted' ? 'mid-halt only (the old row)' : tag === 'line40' ? 'the line cut at 40 m (the spec\'s number)' : 'every man on the line (ruled, cut at 44 m)'}: `
      + `${st2} side-ticks, mean men counted ${(n(`B3POP ${tag} men`) / Math.max(st2, 1)).toFixed(1)}`);
    console.log(`     x out of the old 20-60 m band   ${pc(`B3POP ${tag} x out of the old 20-60 band`, `B3POP ${tag} side-ticks`)}`);
    console.log(`     x out of the ruled 0.6x floor   ${pc(`B3POP ${tag} x out of the ruled floor`, `B3POP ${tag} side-ticks`)}`);
    console.log(`     x under a 10 m sd               ${pc(`B3POP ${tag} x under a 10 m sd`, `B3POP ${tag} side-ticks`)}`);
    console.log(`     z per squad out of 2-12 m       ${pc(`B3POP ${tag} z out of 2-12`, `B3POP ${tag} squad z-ticks`)} of ${n(`B3POP ${tag} squad z-ticks`)} squad-ticks`);
    console.log(`     z per squad out of the old 4-12 ${pc(`B3POP ${tag} z out of the old 4-12`, `B3POP ${tag} squad z-ticks`)}`);
  }
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
  if (A4AWHY) {
    const sorted = a4aWindows.slice().sort((a, b) => a.changes - b.changes);
    console.log(`A4a's quietest windows, named (seed/side, tick range, changes, live tanks, bounding, scoot words, slot words):`);
    for (const w of sorted.slice(0, 6))
      console.log(`  seed ${w.seed} side ${w.sd}  t${w.from}-${w.to}  changes ${w.changes}  live ${w.live}  `
        + `bounding ${w.bounding}  scoot ${w.scoot}  slot ${w.slot}`);
    const byWindow = {};
    for (const w of a4aWindows) { const k = `${w.from}-${w.to}`; byWindow[k] = (byWindow[k] || 0) + w.changes; }
    console.log(`  changes by window across all seeds and sides: `
      + Object.entries(byWindow).map(([k, v]) => `${k} ${v}`).join(', '));
  }
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
