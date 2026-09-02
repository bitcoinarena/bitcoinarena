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

const Q = 65536;
const q = (v) => v / Q;
const isArmour = (i) => (i & 3) === 0;
const RADIUS = HAS_AIR ? q(air.BOMB_RADIUS) : 16;
const RIFLE_RANGE = 26;

const ref = JSON.parse(readFileSync(new URL('../test/vectors/csharp-infantry.json', import.meta.url), 'utf8'));
const REF = ref.passes.line.rows;

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

function measure(seed) {
  const tally = { helis: 0, bombs: 0 };
  const st = start(seed, tally);
  let prev = census(st);
  let prevBombs = bombSlots(st);
  let rifleKills = 0, bombKills = 0, arrived = 0;
  const rows = [];

  console.log(`INFCORE BEGIN  seed=${seed}${SEAM0 ? ' seam0' : ''} ${cond()}`);

  const sample = (t) => {
    const l = line(prev);
    const r = REF.find((x) => Math.abs(x.t - t) < 0.01);
    const refPart = r
      ? `  | REC bull ${r.bullInf.n}@${r.bullInf.z.toFixed(1)} bear ${r.bearInf.n}@${r.bearInf.z.toFixed(1)} ` +
        `nearest=${r.nearestPair.toFixed(1)} mean=${r.meanNearest.toFixed(1)} inRange=${r.inRifleRange} ` +
        `rifleKills=${r.rifleKills.bull + r.rifleKills.bear}`
      : '';
    console.log(`INFCORE t=${t.toFixed(0)} bull ${l.bull.n}@${l.bull.z.toFixed(1)}sd${l.bull.spread.toFixed(1)} ` +
                `bear ${l.bear.n}@${l.bear.z.toFixed(1)}sd${l.bear.spread.toFixed(1)} ` +
                `nearest=${l.nearestPair.toFixed(1)} mean=${l.meanNearest.toFixed(1)} ` +
                `inRange=${l.inRifleRange} rifleKills=${rifleKills} bombKills=${bombKills}` + refPart);
    rows.push({ t, ...l, rifleKills, bombKills });
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

    prev = now; prevBombs = nowBombs;
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
           heldHelis: tally.helis, heldBombs: tally.bombs };
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
  return all;
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
}

if (SORTIES === 'both') {
  const off = runCondition('off');
  const grounded = runCondition('grounded');
  const on = runCondition('on');
  table([['core (squads) clocks', off, on], ['core (squads) grounded', grounded, on]]);
} else {
  runCondition(SORTIES);
}
