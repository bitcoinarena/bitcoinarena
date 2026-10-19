// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// The core's infantry line, laid beside test/vectors/csharp-infantry.json.
//
// Written for item (h). The armour has been measured against a recording for
// weeks; the riflemen - 72 of the 96 units a side - never were, because
// csharp-army.json carries only their count, mean z and spread, and
// replacement holds the count at 34-36 of 36 whatever happens to them.
//
// The three quantities that say whether this is the same line:
//
//   nearestPair    the closest any two opposing riflemen come. The C# lines
//                  interpenetrate and come within 4.7 m; a core that backs a
//                  man off inside 24 m answers 24.0 at every sample, and no
//                  16 m blast can then catch men from both sides.
//   inRifleRange   how many men have an enemy inside 26 m - the infantry's
//                  version of the armour's shooter count.
//   rifleKills     deaths that no blast can account for. Attributed the way
//                  measure-air.js does it: a detonation is a bomb slot that
//                  was live and is now free, and a corpse inside the radius
//                  belongs to it. Everything left over was shot.
//
//     node tools/measure-infantry.js [seed ...] [--seam0] [--core=DIR]
//                                      [--sorties=on|off|grounded|both]
//
// --seam0 pins the frontline at z=0, which is the recording's condition.
// --core=DIR loads the core from elsewhere - a worktree from before a change
// is the before half of a before-and-after.
//
// --sorties= holds the air down from OUT HERE, on whatever core is loaded.
//
// Until now the only way to read the core with no air was --core= a worktree
// from before rules/air.js landed - and that worktree is also from before the
// squads landed, so the air-off column and the air-on column were two different
// armies. This flag takes the air off the CURRENT core instead, without a
// switch in the rules and without touching a rule at all:
//
//   off        the two sortie clocks are pinned high after every tick, so
//              launchSorties never fires and the air draws NOTHING from the
//              stream. This is the recording's own condition -
//              ArmyReferenceTests calls no LaunchSorties either.
//   grounded   the clocks run and their draws land on the stream as usual, but
//              every gunship slot is cleared the tick it is filled, so nothing
//              ever flies and no bomb is ever released. The sortie's draws are
//              paid for; the bombs are not.
//   both       runs off and then on and prints the two envelopes and the ratio
//              beside the C# recording's own two conditions.
//
// The two hold modes exist to say whether the answer is an artefact of WHICH
// draws were withheld. They consume different amounts of the stream, so they
// are different rounds, and if they land on the same envelope the choice did
// not decide the number.
//
// What no hold can do is make one seed comparable across conditions: every
// draw the air makes comes off the same stream the ground fight uses, so
// air-off seed 20260901 and air-on seed 20260901 are not the same battle with
// the bombs removed - they are two battles. Only the envelope over the four
// seeds is a comparison, which is the same rule the C# recording is read under.
//
// Prints; asserts nothing, except that a held run really did stay on the
// ground: the gunships and bombs cleared are counted and printed, and in
// --sorties=off both counts must be zero or the clock pin did not hold.
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const SEAM0 = args.includes('--seam0');
const CORE = (args.find((a) => a.startsWith('--core=')) || '--core=../src').slice(7);
const SEEDS = args.filter((a) => !a.startsWith('--')).map(Number);
if (SEEDS.length === 0) SEEDS.push(20260901, 20260902, 20260903, 20260904);
const SORTIES = (args.find((a) => a.startsWith('--sorties=')) || '--sorties=on').slice(10);
if (!['on', 'off', 'grounded', 'both'].includes(SORTIES))
  throw new Error('--sorties= takes on, off, grounded or both');

/**
 * Which condition the run being printed is under. Set by runCondition; every
 * line the tool prints carries it, for the reason measure-army.js's air=on/off
 * exists - a number that does not say which condition it was made under is not
 * a measurement.
 */
let MODE = SORTIES === 'both' ? 'off' : SORTIES;
const cond = () => (MODE === 'on'
  ? `air=${HAS_AIR ? 'on' : 'off'}`
  : `air=held(${MODE})`);

const base = new URL(CORE + '/', import.meta.url);
const { init, step, UNITS } = await import(new URL('sim.js', base).pathname);
const L = await import(new URL('state.js', base).pathname);
const HAS_AIR = typeof L.O_HELIS === 'number';
const air = HAS_AIR ? await import(new URL('rules/air.js', base).pathname) : null;
// A core from before rules/air.js has no sortie clock and no gunship slots, so
// there is nothing to hold down and the words the hold would write are not in
// its layout. That core is already air-off; asking for the flag on it is a
// mistake about which core is loaded, and it is caught here rather than
// silently writing state[NaN].
if (SORTIES !== 'on' && !HAS_AIR)
  throw new Error(`--sorties=${SORTIES} wants a core with an air arm; ${CORE} has none (it is air-off already)`);

/**
 * The rifle's own clock words, from the core that is loaded - not copied here.
 * A shot sets the reload (2.5-4.5 s); a man who looked and found nobody sets
 * the look (0.4-1.1 s). The two bands do not overlap, which is what makes a
 * shot visible from outside: nothing else writes U_COOLDOWN except a spawn,
 * and a spawn is a slot that was refilled and is excluded.
 */
const army = await import(new URL('rules/army.js', base).pathname);
const RELOAD_TICKS = army.RIFLE_RELOAD_TICKS;
const LOOK_TICKS = army.RIFLE_LOOK_TICKS;

const Q = 65536;
const q = (v) => v / Q;
const isArmour = (i) => (i & 3) === 0;
const RADIUS = HAS_AIR ? q(air.BOMB_RADIUS) : 16;
const RIFLE_RANGE = 26;

const ref = JSON.parse(readFileSync(new URL('../test/vectors/csharp-infantry.json', import.meta.url), 'utf8'));

/**
 * The recording's rows FOR THIS SEED, or null.
 *
 * csharp-infantry.json carries four line passes - the unlabelled `line` is the
 * file's own `setup.seed`, and `line-<seed>` the other three - and every core
 * seed used to be annotated with the first of them. That is the same mistake
 * the depth pair was: a REC column that is not the pair of the core column
 * printed beside it. The seed is read off the file (a pass's own `seed`, else
 * `setup.seed`) rather than remembered here, so a re-record cannot leave a
 * stale pairing standing, and a seed the recording does not hold gets no REC
 * cells at all and says so.
 *
 * `line-24-72` is a different establishment - 24 armour and 72 infantry - and
 * is never a pair for a 12/36 core run whatever seed it was made on.
 */
const refPass = (seed) => Object.entries(ref.passes).find(([name, pass]) =>
  (name === 'line' || name.startsWith('line-')) && name !== 'line-24-72' &&
  (pass.seed ?? ref.setup.seed) === seed)?.[1] ?? null;

const dt = 1 / 60;
const TICKS = 90 * 60;
const SAMPLE = 5 * 60;

function pinSeam(st) { st.tape.fill(st.tape[0]); return st; }

/**
 * Long enough that the clock never runs out: 2^30 in Q16.16 is 16384 seconds
 * against a round of ninety, and launchSorties takes one tick off it per tick.
 */
const CLOCK_HIGH = 1 << 30;

/**
 * Holds the air down, from outside the rules.
 *
 * Called on the fresh state and again after every tick. Two things happen, and
 * only the first depends on the mode:
 *
 *   the sortie clocks are pinned (mode 'off' only), which is the whole of the
 *   suppression - `launchSorties` subtracts a tick, sees a positive word and
 *   returns without drawing.
 *
 *   every live gunship and every live bomb is cleared, in BOTH hold modes.
 *   In 'grounded' that is the suppression: a gunship launched at the end of a
 *   tick is gone before the next tick would fly it, so it never reaches the
 *   drop gate and never releases. In 'off' nothing should ever be live here at
 *   all, and the counts printed at the end are the evidence that the pin held.
 *
 * No rule is called, no rule is edited, and nothing but the air's own state
 * words is written. The units, the squads, the tape and the stream are left
 * exactly as the core left them.
 */
function hold(st, tally) {
  if (MODE === 'on') return st;
  const s = st.i32;
  if (MODE === 'off') {
    s[L.O_AIR + L.AIR_BULL] = CLOCK_HIGH;
    s[L.O_AIR + L.AIR_BEAR] = CLOCK_HIGH;
  }
  for (let i = 0; i < L.MAX_HELIS; i++) {
    const o = L.heliBase(i);
    if (s[o + L.H_STATE] === 0) continue;
    s[o + L.H_STATE] = 0;
    tally.helis++;
  }
  for (let i = 0; i < L.MAX_BOMBS; i++) {
    const o = L.bombBase(i);
    if (s[o + L.B_STATE] === 0) continue;
    s[o + L.B_STATE] = 0;
    tally.bombs++;
  }
  return st;
}

const start = (seed, tally) => hold(SEAM0 ? pinSeam(init(seed)) : init(seed), tally);

function census(st) {
  const out = [];
  for (let i = 0; i < UNITS; i++) {
    const o = L.unitBase(i);
    out.push({
      i, armour: isArmour(i), side: st.i32[o + L.U_SIDE],
      alive: st.i32[o + L.U_STATE] !== 0 && st.i32[o + L.U_HP] > 0,
      x: q(st.i32[o + L.U_X]), z: q(st.i32[o + L.U_Z]), hp: q(st.i32[o + L.U_HP]),
      cool: st.i32[o + L.U_COOLDOWN],
    });
  }
  return out;
}

function bombSlots(st) {
  if (!HAS_AIR) return [];
  const out = [];
  for (let i = 0; i < L.MAX_BOMBS; i++) {
    const o = L.bombBase(i);
    out.push({ live: st.i32[o + L.B_STATE] !== 0,
               x: q(st.i32[o + L.B_X]), z: q(st.i32[o + L.B_Z]) });
  }
  return out;
}

/** Where each side's riflemen stand, and how close they get to each other. */
function line(now) {
  const men = now.filter((u) => u.alive && !u.armour);
  const bull = men.filter((u) => u.side < 0);
  const bear = men.filter((u) => u.side > 0);
  const stat = (g) => {
    if (g.length === 0) return { n: 0, z: 0, spread: 0 };
    const m = g.reduce((a, u) => a + u.z, 0) / g.length;
    const v = g.reduce((a, u) => a + (u.z - m) * (u.z - m), 0) / g.length;
    return { n: g.length, z: m, spread: Math.sqrt(v) };
  };

  let nearestPair = Infinity, sum = 0, counted = 0, inRange = 0;
  for (const a of men) {
    let best = Infinity;
    for (const b of men) {
      if (b.side === a.side) continue;
      const d = Math.hypot(b.x - a.x, b.z - a.z);
      if (d < best) best = d;
    }
    if (best === Infinity) continue;
    if (best < nearestPair) nearestPair = best;
    if (best < RIFLE_RANGE) inRange++;
    sum += best; counted++;
  }
  return {
    bull: stat(bull), bear: stat(bear),
    nearestPair: counted ? nearestPair : 0,
    meanNearest: counted ? sum / counted : 0,
    inRifleRange: inRange,
  };
}

/**
 * How many riflemen have an enemy inside 26 m, counted EVERY tick.
 *
 * `line()` answers the same question at the samples, and the samples are all
 * the recording has. They are not enough for a rate over a window in which the
 * line ARRIVES: the core's line is a plank and goes from nobody in range to
 * forty inside one five-second window, so averaging the window's two ends
 * charges it with men-seconds it never had, and its early rate comes out
 * halved. The C# line is 6.5 m deep by the time it arrives and ramps over two
 * or three windows, so the same average costs it much less. That is a property
 * of the instrument, not of the gun, and this is the integral that removes it
 * from the core's column. Nothing can remove it from the recording's - five
 * seconds is what it published - so both columns are printed both ways.
 *
 * Same test as `line()`'s, an enemy strictly inside the range, with the axis
 * rejections that make it cheap enough to run 5400 times a round.
 */
function inRangeCount(now) {
  const men = [];
  for (let i = 0; i < UNITS; i++) if (now[i].alive && !now[i].armour) men.push(now[i]);
  const R2 = RIFLE_RANGE * RIFLE_RANGE;
  let n = 0;
  for (const a of men)
    for (const b of men) {
      if (b.side === a.side) continue;
      const dx = b.x - a.x; if (dx > RIFLE_RANGE || dx < -RIFLE_RANGE) continue;
      const dz = b.z - a.z; if (dz > RIFLE_RANGE || dz < -RIFLE_RANGE) continue;
      if (dx * dx + dz * dz < R2) { n++; break; }
    }
  return n;
}

function measure(seed) {
  const tally = { helis: 0, bombs: 0 };
  const pass = refPass(seed);
  const REF = pass ? pass.rows : null;
  const st = start(seed, tally);
  let prev = census(st);
  let prevBombs = bombSlots(st);
  let rifleKills = 0, bombKills = 0, arrived = 0;
  // Men-with-an-enemy-in-reach, summed over the ticks of the window just
  // ended, so a window's exposure is an integral and not two end points.
  let manTicks = 0;
  // THE SHOT LEDGER. Kills alone cannot say whether a thin exchange is a
  // clock or a roll: the hit chance is a fixed 45 in 1000 and a hit is fatal,
  // so kills are shots times a constant. What is countable from outside is the
  // clock word - a rifleman who fires sets 150-269 ticks and a rifleman who
  // looked and found nobody sets 24-65, and the bands do not meet.
  let shots = 0, looks = 0;
  const rows = [];

  console.log(`INFCORE BEGIN  seed=${seed}${SEAM0 ? ' seam0' : ''} ${cond()}` +
              (REF ? '' : '   (the recording holds no line pass for this seed - no REC cells)'));

  const sample = (t) => {
    const l = line(prev);
    const r = REF && REF.find((x) => Math.abs(x.t - t) < 0.01);
    const refPart = r
      ? `  | REC bull ${r.bullInf.n}@${r.bullInf.z.toFixed(1)} bear ${r.bearInf.n}@${r.bearInf.z.toFixed(1)} ` +
        `nearest=${r.nearestPair.toFixed(1)} mean=${r.meanNearest.toFixed(1)} inRange=${r.inRifleRange} ` +
        `rifleKills=${r.rifleKills.bull + r.rifleKills.bear}`
      : '';
    console.log(`INFCORE t=${t.toFixed(0)} bull ${l.bull.n}@${l.bull.z.toFixed(1)}sd${l.bull.spread.toFixed(1)} ` +
                `bear ${l.bear.n}@${l.bear.z.toFixed(1)}sd${l.bear.spread.toFixed(1)} ` +
                `nearest=${l.nearestPair.toFixed(1)} mean=${l.meanNearest.toFixed(1)} ` +
                `inRange=${l.inRifleRange} rifleKills=${rifleKills} bombKills=${bombKills}` + refPart);
    rows.push({ t, ...l, rifleKills, bombKills, manMean: manTicks / SAMPLE, shots, looks });
    manTicks = 0; shots = 0; looks = 0;
  };
  sample(0);

  for (let f = 0; f < TICKS; f++) {
    step(st, 0, 0, 0, 0, 0);
    // Between the tick and the census, so nothing downstream ever sees an
    // aircraft the hold means to have taken away.
    hold(st, tally);
    const now = census(st);
    const nowBombs = bombSlots(st);

    const landed = [];
    for (let i = 0; i < prevBombs.length; i++)
      if (prevBombs[i].live && !nowBombs[i].live) landed.push(nowBombs[i]);

    // A slot that died and was refilled inside one tick reads as a heal, which
    // is how reinforce shows from outside: it takes the first free slot, and
    // that can be the one that just emptied.
    const dead = [];
    for (let i = 0; i < UNITS; i++) {
      const a = prev[i], b = now[i];
      const healed = a.alive && b.alive && b.hp > a.hp;
      if ((!a.alive && b.alive) || healed) arrived++;
      if (!((a.alive && !b.alive) || healed)) continue;
      const at = healed ? a : b;
      dead.push({ armour: a.armour, x: at.x, z: at.z, claimed: false });
    }

    for (const bomb of landed)
      for (const d of dead)
        if (Math.hypot(d.x - bomb.x, d.z - bomb.z) <= RADIUS) d.claimed = true;

    for (const d of dead) {
      if (d.armour) continue;
      if (d.claimed) bombKills++; else rifleKills++;
    }

    // Read before prev is replaced: a clock that went up this tick was set by
    // this tick's unit loop. Slots that were refilled underneath are skipped -
    // a fresh man is given a spawn cooldown, and that is not a shot.
    for (let i = 0; i < UNITS; i++) {
      const a = prev[i], b = now[i];
      if (a.armour || !a.alive || !b.alive || b.hp > a.hp) continue;
      if (b.cool <= a.cool) continue;
      if (b.cool >= RELOAD_TICKS) shots++;
      else if (b.cool >= LOOK_TICKS) looks++;
    }

    prev = now; prevBombs = nowBombs;
    manTicks += inRangeCount(now);
    if ((f + 1) % SAMPLE === 0) sample((f + 1) * dt);
  }

  const inContact = rows.filter((r) => r.t >= 25);
  const span = (f) => [Math.min(...inContact.map(f)), Math.max(...inContact.map(f))];
  const [np0, np1] = span((r) => r.nearestPair);
  const [mn0, mn1] = span((r) => r.meanNearest);
  const [ir0, ir1] = span((r) => r.inRifleRange);
  console.log(`INFCORE summary seed=${seed} ${cond()} nearestPair=${np0.toFixed(1)}-${np1.toFixed(1)} ` +
              `meanNearest=${mn0.toFixed(1)}-${mn1.toFixed(1)} inRifleRange=${ir0}-${ir1} ` +
              `rifleKills=${rifleKills} bombKills=${bombKills}` +
              (MODE === 'on' ? '' : ` held gunships=${tally.helis} bombs=${tally.bombs}`));
  return { seed, np0, np1, mn0, mn1, ir0, ir1, rifleKills, bombKills,
           heldHelis: tally.helis, heldBombs: tally.bombs, rows, ref: REF };
}

/** One condition, run over every seed, and its envelope. */
function runCondition(mode) {
  MODE = mode;
  const all = SEEDS.map(measure);
  const e = ref.envelope;
  const lo = (f) => Math.min(...all.map(f)), hi = (f) => Math.max(...all.map(f));
  console.log('');
  console.log(`INFCORE ENVELOPE ${cond()} (the recording's rows beside it are air-off)`);
  console.log(`INFCORE nearestPair   core ${lo((r) => r.np0).toFixed(1)}-${hi((r) => r.np1).toFixed(1)}` +
              `   REC ${e.nearestOpposingPair[0]}-${e.nearestOpposingPair[1]}`);
  console.log(`INFCORE meanNearest   core ${lo((r) => r.mn0).toFixed(1)}-${hi((r) => r.mn1).toFixed(1)}` +
              `   REC ${e.meanNearestEnemy[0]}-${e.meanNearestEnemy[1]}`);
  console.log(`INFCORE inRifleRange  core ${lo((r) => r.ir0)}-${hi((r) => r.ir1)}` +
              `   REC ${e.riflemenInRange[0]}-${e.riflemenInRange[1]}`);
  console.log(`INFCORE rifleKills    core ${lo((r) => r.rifleKills)}-${hi((r) => r.rifleKills)}` +
              `   REC ${e.rifleKillsPerRound}`);
  console.log(`INFCORE bombKills     core ${lo((r) => r.bombKills)}-${hi((r) => r.bombKills)}   REC (air off) -`);
  if (mode !== 'on') {
    const hh = all.reduce((a, r) => a + r.heldHelis, 0), hb = all.reduce((a, r) => a + r.heldBombs, 0);
    console.log(`INFCORE held          gunships=${hh} bombs=${hb}` +
                (mode === 'off'
                  ? (hh === 0 && hb === 0
                      ? '   (both zero: the clock pin held and nothing ever launched)'
                      : '   *** NOT ZERO: the clock pin did NOT hold - this run is not air-off ***')
                  : '   (cleared the tick they were filled; a bomb here would be a fault)'));
  }
  if (mode !== 'on') contactWindows(all);
  return all;
}

// ---------------------------------------------------------------------------
// CONTACT WINDOWS: the rifle line's rate, per five seconds, per man in range.
//
// The air-off rifle envelopes overlap (core 24-42 against the recording's
// 28-51) and this file's reading of that is four-seed scatter - how well the
// two lines happened to meet. `inRifleRange` is the quantity that says how well
// they met, and BOTH engines publish it at every sample, so it can be divided
// out: kills per man with an enemy in reach, rather than kills.
//
// Two things this fixes about the whole-round number:
//
//   it is anchored on CONTACT, not on the clock. Contact is at a different t in
//   each engine and on each seed - the seed decides where three squads a side
//   land - so a fixed cut compares a core still walking against a C# already
//   fighting. w0 is the first window in which that engine had a man in range.
//   Through the approach both engines' inRifleRange and rifleKills are zero, so
//   nothing is being sliced off a line that was shooting.
//
//   it separates AT CONTACT from LATE. If the core's rate is the recording's in
//   the first windows and falls away after, that is attrition or churn; if it is
//   below from the first exchange, it is the gun.
//
// Air off on both sides, and conditioned on the recording's own setup block -
// `air: "none"` and the pinned seam - so the pair cannot go stale under a
// re-record. Core rows are this run's; the REC rows are that seed's own pass.
const REC_AIR_OFF = ref.setup.air === 'none';

/**
 * Per-window deltas, and where contact starts, for one engine's rows.
 *
 * `trap` is the exposure both engines can publish - the men in range at the
 * window's two ends, averaged. `mean` is the integral over the window's ticks
 * and exists for the core only, because the recording holds five-second
 * samples and nothing between them.
 */
function windows(rows, kills, inRange, exact) {
  const out = [];
  for (let i = 1; i < rows.length; i++)
    out.push({ t: rows[i].t, dKills: kills(rows[i]) - kills(rows[i - 1]),
               trap: (inRange(rows[i]) + inRange(rows[i - 1])) / 2,
               mean: exact ? exact(rows[i]) : null,
               shots: rows[i].shots ?? null, looks: rows[i].looks ?? null });
  // The window that ENDS at the first sample holding a man in range: the men
  // came into reach during it, and its kills are the first exchange.
  const at = rows.findIndex((r) => inRange(r) > 0);
  return { out, anchor: at < 1 ? 0 : at - 1, contactAt: at < 0 ? null : rows[at].t };
}

const rate = (k, m) => (m > 0 ? k / m : NaN);
const num = (v, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : '-');

function contactWindows(all) {
  console.log('');
  console.log('INFCORE ' + '='.repeat(62));
  console.log(`INFCORE CONTACT WINDOWS  ${cond()}, five-second windows, anchored on each`);
  console.log("INFCORE   engine's own first man-in-range. rate = rifle kills / men in range.");
  console.log('INFCORE   The core carries two exposures: `mean` is every tick of the window,');
  console.log('INFCORE   `trap` is the two end points averaged, which is all the recording can');
  console.log('INFCORE   be read as. A line that arrives inside one window is overcharged by');
  console.log('INFCORE   trap, and the core\'s arrives as a plank - so the two core columns are');
  console.log('INFCORE   the size of that artefact, and only trap-against-trap is like for like.');
  if (!SEAM0 || !REC_AIR_OFF) {
    console.log(`INFCORE   REC column WITHHELD: the recording's setup is air=${JSON.stringify(ref.setup.air)}` +
                ` and this run is ${SEAM0 ? 'seam pinned' : 'NOT seam pinned'} - not a pair.`);
    return;
  }

  const sums = [];
  for (const r of all) {
    const c = windows(r.rows, (x) => x.rifleKills, (x) => x.inRifleRange, (x) => x.manMean);
    const k = r.ref ? windows(r.ref, (x) => x.rifleKills.bull + x.rifleKills.bear,
                              (x) => x.inRifleRange) : null;
    console.log('INFCORE');
    console.log(`INFCORE seed=${r.seed} contact core t=${c.contactAt ?? 'never'}` +
                (k ? `  REC t=${k.contactAt ?? 'never'}` : '  REC (no pass for this seed)'));
    console.log('INFCORE   w    t   kills  mean  trap  rate(mean) rate(trap) |  t   kills  trap  rate');
    const n = Math.max(c.out.length - c.anchor, k ? k.out.length - k.anchor : 0);
    for (let w = 0; w < n; w++) {
      const a = c.out[c.anchor + w], b = k ? k.out[k.anchor + w] : null;
      const core = a
        ? `${String(a.t.toFixed(0)).padStart(3)}   ${String(a.dKills).padStart(3)}  ` +
          `${a.mean.toFixed(1).padStart(5)} ${a.trap.toFixed(1).padStart(5)}  ` +
          `${num(rate(a.dKills, a.mean)).padStart(8)}   ${num(rate(a.dKills, a.trap)).padStart(8)}`
        : ' '.repeat(45);
      const rec = b
        ? `${String(b.t.toFixed(0)).padStart(3)}   ${String(b.dKills).padStart(3)}  ` +
          `${b.trap.toFixed(1).padStart(5)}  ${num(rate(b.dKills, b.trap))}`
        : '  -     -      -   -';
      console.log(`INFCORE   ${String(w).padEnd(4)} ${core} | ${rec}`);
    }
    // Post-contact totals, and the same split three windows in: at contact
    // against later, which is what says whether a deficit is the first
    // exchange or an accumulation.
    const tot = (x, field) => {
      if (!x) return null;
      const win = x.out.slice(x.anchor);
      const sum = (f, from = 0, to = win.length) => win.slice(from, to).reduce((s, v) => s + f(v), 0);
      return { kills: sum((v) => v.dKills), men: sum((v) => v[field]),
               earlyK: sum((v) => v.dKills, 0, 3), earlyM: sum((v) => v[field], 0, 3),
               lateK: sum((v) => v.dKills, 3), lateM: sum((v) => v[field], 3) };
    };
    const cm = tot(c, 'mean'), ct = tot(c, 'trap'), kt = tot(k, 'trap');
    // The ledger, core only: the recording holds deaths, not trigger pulls.
    const led = (from, to) => {
      const win = c.out.slice(c.anchor).slice(from, to);
      const sum = (f) => win.reduce((a, v) => a + f(v), 0);
      return { shots: sum((v) => v.shots), looks: sum((v) => v.looks),
               men: sum((v) => v.mean), kills: sum((v) => v.dKills) };
    };
    const ledLine = (name, x) => console.log(
      `INFCORE   ${name.padEnd(12)} shots=${String(x.shots).padStart(4)} looks=${String(x.looks).padStart(4)} ` +
      `shotsPerManWindow=${num(rate(x.shots, x.men))} killsPerShot=${num(rate(x.kills, x.shots))} ` +
      `(the roll is a fixed 0.045)`);
    ledLine('core ledger', led(0, Infinity));
    ledLine('  w0-w2', led(0, 3));
    ledLine('  w3+', led(3, Infinity));
    const say = (name, x) => x && console.log(
      `INFCORE   ${name.padEnd(12)} post-contact kills=${String(x.kills).padStart(3)} ` +
      `manWindows=${x.men.toFixed(1).padStart(6)} rate=${num(rate(x.kills, x.men))}   ` +
      `w0-w2 ${num(rate(x.earlyK, x.earlyM))}  w3+ ${num(rate(x.lateK, x.lateM))}`);
    say('core mean', cm); say('core trap', ct); say('REC trap', kt);
    if (cm && kt) sums.push({ seed: r.seed, mean: cm, trap: ct, rec: kt });
  }

  if (sums.length === 0) return;
  const span = (f) => `${num(Math.min(...sums.map(f)))}-${num(Math.max(...sums.map(f)))}`;
  const pooled = (pick, kn, mn) => rate(sums.reduce((a, s) => a + pick(s)[kn], 0),
                                        sums.reduce((a, s) => a + pick(s)[mn], 0));
  console.log('INFCORE');
  console.log(`INFCORE RIFLE KILLS PER MAN IN RANGE, ${cond()}, ${sums.length} seeds`);
  console.log('INFCORE ' + ' '.repeat(28) + 'per seed'.padEnd(16) + 'pooled'.padEnd(10) +
              'w0-w2'.padEnd(10) + 'w3+');
  const row = (name, pick) => console.log(
    'INFCORE ' + name.padEnd(28) +
    span((s) => rate(pick(s).kills, pick(s).men)).padEnd(16) +
    num(pooled(pick, 'kills', 'men')).padEnd(10) +
    num(pooled(pick, 'earlyK', 'earlyM')).padEnd(10) +
    num(pooled(pick, 'lateK', 'lateM')));
  row('core, mean over the ticks', (s) => s.mean);
  row('core, end points (trap)', (s) => s.trap);
  row('C# recording (trap only)', (s) => s.rec);
  // The ledger pooled over the seeds. If the early deficit is in shotsPerMan,
  // it is the clock; if it is in killsPerShot, it is not the clock and the men
  // are firing at something that is not an enemy rifleman.
  const ledger = (from, to) => {
    let shots = 0, looks = 0, men = 0, kills = 0;
    for (const r of all) {
      const c = windows(r.rows, (x) => x.rifleKills, (x) => x.inRifleRange, (x) => x.manMean);
      for (const w of c.out.slice(c.anchor).slice(from, to)) {
        shots += w.shots; looks += w.looks; men += w.mean; kills += w.dKills;
      }
    }
    return { shots, looks, men, kills };
  };
  console.log('INFCORE');
  console.log('INFCORE THE SHOT LEDGER, core only - the recording holds deaths, not trigger pulls');
  console.log('INFCORE ' + ' '.repeat(28) + 'shots'.padEnd(9) + 'looks'.padEnd(9) +
              'shots/man'.padEnd(12) + 'kills/shot');
  for (const [name, from, to] of [['post-contact', 0, Infinity], ['w0-w2', 0, 3], ['w3+', 3, Infinity]]) {
    const x = ledger(from, to);
    console.log('INFCORE ' + name.padEnd(28) + String(x.shots).padEnd(9) + String(x.looks).padEnd(9) +
                num(rate(x.shots, x.men), 3).padEnd(12) + num(rate(x.kills, x.shots), 4));
  }
  console.log('INFCORE   and the kills themselves, which the rate divides the meeting out of:');
  console.log(`INFCORE     core [${sums.map((s) => s.mean.kills)}]  REC [${sums.map((s) => s.rec.kills)}]`);
  console.log('INFCORE     men in range, summed over the windows: core mean ' +
              `[${sums.map((s) => s.mean.men.toFixed(0))}] trap [${sums.map((s) => s.trap.men.toFixed(0))}]` +
              `  REC trap [${sums.map((s) => s.rec.men.toFixed(0))}]`);
  console.log('INFCORE ' + '='.repeat(62));
}

// ---------------------------------------------------------------------------
// The table. The core's two conditions beside the C# recording's own two.
//
// The C# cells are not a quotation: csharp-gunships.json carries a noair pass
// and a gunships pass PER SEED, both with killedByRifle, so the recording's
// air-off column, its air-on column and the ratio between them are read off the
// same recording under the same reading. (Its 28-51 air-off column is also
// csharp-infantry.json's rifleKillsPerRound envelope, measured by other tooling
// on the same four seeds - they agree.)
//
// Always the four recorded seeds, whatever seeds the core was run on: the
// recording has no others, and a C# column silently made of a different set
// would be the kind of comparison this file exists to prevent.
const REC_SEEDS = [20260901, 20260902, 20260903, 20260904];
const gun = JSON.parse(readFileSync(new URL('../test/vectors/csharp-gunships.json', import.meta.url), 'utf8'));
const recInf = (tag, field) => REC_SEEDS.map((s) => gun.passes[`${tag}-${s}`].summary.infantry[field]);

const span = (xs) => `${Math.min(...xs)}-${Math.max(...xs)}`;
const mean = (xs) => xs.reduce((a, c) => a + c, 0) / xs.length;
/**
 * The ratio is of the MEANS, not of the endpoints.
 *
 * Air-off and air-on are different rounds seed for seed - every draw the air
 * makes comes off the ground fight's own stream - so pairing seed to seed is
 * not available, and an envelope's endpoints are two different seeds' extremes.
 * The mean over the four is the one number both columns hold in common.
 */
const ratio = (on, off) => mean(off) === 0 ? NaN : mean(on) / mean(off);

function table(rows) {
  const kills = (all) => all.map((r) => r.rifleKills);
  const bombs = (all) => all.map((r) => r.bombKills);
  const cRifleOff = recInf('noair', 'killedByRifle'), cRifleOn = recInf('gunships', 'killedByRifle');
  const cBombOff = recInf('noair', 'killedByBombs'), cBombOn = recInf('gunships', 'killedByBombs');
  const W = 26, C = 12;
  const line = (name, off, on, r) =>
    console.log('INFCORE ' + name.padEnd(W) + String(off).padEnd(C) + String(on).padEnd(C) +
                (Number.isNaN(r) ? '-' : r.toFixed(2)));

  console.log('');
  console.log('INFCORE ' + '='.repeat(62));
  console.log(`INFCORE RIFLE KILLS A ROUND${SEAM0 ? ', seam pinned' : ''} - core seeds ${SEEDS.join(',')}, ` +
              `C# seeds ${REC_SEEDS.join(',')}`);
  console.log('INFCORE ' + ' '.repeat(W) + 'air off'.padEnd(C) + 'air on'.padEnd(C) + 'ratio on/off');
  for (const [name, off, on] of rows)
    line(name, span(kills(off)), span(kills(on)), ratio(kills(on), kills(off)));
  line('C# recording', span(cRifleOff), span(cRifleOn), ratio(cRifleOn, cRifleOff));
  console.log('INFCORE');
  console.log('INFCORE means, the number the ratio is of:');
  for (const [name, off, on] of rows)
    console.log(`INFCORE   ${name.padEnd(W)}off ${mean(kills(off)).toFixed(1)}  on ${mean(kills(on)).toFixed(1)}` +
                `   per seed off [${kills(off)}] on [${kills(on)}]`);
  console.log(`INFCORE   ${'C# recording'.padEnd(W)}off ${mean(cRifleOff).toFixed(1)}  on ${mean(cRifleOn).toFixed(1)}` +
              `   per seed off [${cRifleOff}] on [${cRifleOn}]`);
  console.log('INFCORE');
  console.log('INFCORE BOMB KILLS A ROUND, the other half of the toll:');
  for (const [name, off, on] of rows)
    console.log(`INFCORE   ${name.padEnd(W)}off ${span(bombs(off))}  on ${span(bombs(on))}`);
  console.log(`INFCORE   ${'C# recording'.padEnd(W)}off ${span(cBombOff)}  on ${span(cBombOn)}`);
  console.log('INFCORE ' + '='.repeat(62));
  bridge(rows, cRifleOff, cRifleOn, cBombOn);
}

/**
 * THE SLOPE BRIDGE: how many rifle kills a round does one bomb death cost?
 *
 * The two open numbers are the core's rifle line (half the recording's) and
 * the core's bomb toll (a third more than the recording's), and the standing
 * question is whether they are ONE fact or two. A man taken by a bomb stops
 * shooting and is replaced from the edge, so some of the rifle deficit is
 * bought by the bomb excess by arithmetic alone - and how much is not a matter
 * of opinion, because each engine publishes its OWN exchange rate:
 *
 *     slope = (rifle kills air-off - rifle kills air-on) / bomb kills air-on
 *
 * Both terms are measured in the same engine under its own two conditions, so
 * the slope is a property of that engine and needs nothing from the other one.
 * Every number here is already recorded: the C# column is csharp-gunships.json's
 * noair and gunships passes, the core's is the two conditions run above.
 *
 * Of the means, and only of the means, for the reason the ratio above is: the
 * air draws off the same stream the ground fight uses, so air-off seed X and
 * air-on seed X are two battles and there is no seed-to-seed pairing to make.
 * Four seeds is four points; the per-seed scatter is printed underneath so the
 * slope is never read as tighter than the sample it came from.
 *
 * What it decides: if the core's slope IS the recording's, then the core's
 * rifle line is what its bomb count implies and there is nothing further to
 * find in the rifle rule - the whole of (l) is the bomb count, which is
 * menPerEffectiveBomb, which is already an open measurement. Only a residual
 * that survives the slope needs a new recorder pass to chase.
 */
function bridge(rows, cRifleOff, cRifleOn, cBombOn) {
  const mean = (xs) => xs.reduce((a, c) => a + c, 0) / xs.length;
  const kills = (all) => all.map((r) => r.rifleKills);
  const bombs = (all) => all.map((r) => r.bombKills);
  const cSlope = (mean(cRifleOff) - mean(cRifleOn)) / mean(cBombOn);

  console.log('');
  console.log('INFCORE ' + '='.repeat(62));
  console.log('INFCORE THE SLOPE: rifle kills a round given up per man taken by a bomb');
  console.log('INFCORE   slope = (rifleOff - rifleOn) / bombKillsOn, of the means, per engine');
  console.log('INFCORE ' + ' '.repeat(26) + 'rifleOff'.padEnd(10) + 'rifleOn'.padEnd(10) +
              'bombsOn'.padEnd(10) + 'slope');
  const line = (name, ro, rn, bn) =>
    console.log('INFCORE ' + name.padEnd(26) + ro.toFixed(1).padEnd(10) + rn.toFixed(1).padEnd(10) +
                bn.toFixed(1).padEnd(10) + ((ro - rn) / bn).toFixed(3));
  for (const [name, off, on] of rows)
    line(name, mean(kills(off)), mean(kills(on)), mean(bombs(on)));
  line('C# recording', mean(cRifleOff), mean(cRifleOn), mean(cBombOn));

  // The gap the item is about, split into the three things that make it. The
  // terms are constructed to sum to it exactly, so nothing hides in a rounding.
  console.log('INFCORE');
  console.log('INFCORE THE AIR-ON RIFLE GAP, taken apart at the recording\'s own slope:');
  for (const [name, off, on] of rows) {
    const ro = mean(kills(off)), rn = mean(kills(on)), bn = mean(bombs(on));
    const gap = mean(cRifleOn) - rn;
    const base = mean(cRifleOff) - ro;                  // already there with no air at all
    const extra = cSlope * (bn - mean(cBombOn));        // bought by the extra bomb dead
    const resid = gap - base - extra;                   // what the slope does NOT explain
    console.log(`INFCORE   ${name}`);
    console.log(`INFCORE     C# air-on ${mean(cRifleOn).toFixed(1)} - core air-on ${rn.toFixed(1)} ` +
                `= ${gap.toFixed(1)} rifle kills a round, of which`);
    console.log(`INFCORE       ${base.toFixed(1).padStart(5)}  was already there AIR OFF ` +
                `(${mean(cRifleOff).toFixed(1)} vs ${ro.toFixed(1)}) - not the air's doing`);
    console.log(`INFCORE       ${extra.toFixed(1).padStart(5)}  is the ${(bn - mean(cBombOn)).toFixed(1)} ` +
                `extra men the core's bombs take, at the recording's own ${cSlope.toFixed(3)}`);
    console.log(`INFCORE       ${resid.toFixed(1).padStart(5)}  is RESIDUAL - the core giving up more per bomb death ` +
                `than the C# does`);
  }

  // Four points, printed, so the slope is read at the width of its sample.
  console.log('INFCORE');
  console.log('INFCORE the scatter the slope is drawn through (air-on, per seed):');
  for (const [name, , on] of rows)
    console.log(`INFCORE   ${name.padEnd(26)}bombs [${bombs(on)}]  rifle [${kills(on)}]`);
  console.log(`INFCORE   ${'C# recording'.padEnd(26)}bombs [${cBombOn}]  rifle [${cRifleOn}]`);
  console.log('INFCORE ' + '='.repeat(62));
}

if (SORTIES === 'both') {
  const off = runCondition('off');
  const grounded = runCondition('grounded');
  const on = runCondition('on');
  table([['core (squads) clocks', off, on], ['core (squads) grounded', grounded, on]]);
} else {
  runCondition(SORTIES);
}
