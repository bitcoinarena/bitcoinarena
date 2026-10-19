// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Per-squad losses in the core army, laid beside test/vectors/csharp-army.json.
//
// Written for one question: the shooter count collapsing to zero by t=60 while
// the x spread grows - is that survivorship (the middle squads wiped, the
// flanks alive) or drift (everyone alive but nobody in range of anybody)?
// Those two have opposite fixes, and counting per squad separates them: under
// survivorship the dead are concentrated in a few squads, under drift the
// losses are spread and the survivors are simply too far apart.
//
// The run settled a THIRD reading that is neither: the two sides end up
// holding squad columns that do not overlap, so no shot is possible however
// many tanks are alive. See the columns and nearest-enemy lines at the end.
//
// Prints; asserts nothing. Same shape as tools/measure.js.
//
//     node tools/measure-army.js [seed ...] [--seam0] [--quiet] [--airoff]
//
// --seam0 pins the frontline at z=0, which is the condition the C# recording
// was made under (ArmyReferenceTests sets FrontlineAt = _ => 0). Without it
// the seam sits where the price tape puts it - +27.3 m - and the two armies
// start 105 m and 51 m from the line respectively, which is not the fight the
// recording holds. Any number compared against the recording wants this flag.
//
// --quiet drops the per-death list and prints the marks and the summary only.
//
// --core=DIR loads the core from somewhere else, which is the only way to turn
// the air off: the core has no switch for it, and `ArmyReferenceTests` launches
// no sorties, so every number this tool has printed since the air landed has
// been an air-ON core beside an air-OFF recording. Checking one against the
// other is what this flag is for:
//
//     git worktree add /tmp/noair <the commit before rules/air.js>
//     node tools/measure-army.js 20260901 --seam0 --quiet \
//       --core=/tmp/noair/packages/nextblock/src
//
// Every line carries air=on or air=off for the same reason. A comparison that
// does not say which condition it was made under is not a comparison.
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const SEAM0 = args.includes('--seam0');
const QUIET = args.includes('--quiet');
const CORE = (args.find((a) => a.startsWith('--core=')) || '--core=../src').slice(7);
const AIROFF = args.includes('--airoff');
/**
 * THE ENVELOPE SEEDS, pinned so the verdict is repeatable.
 *
 * The commit that first reported "78 of 78" says "Thirty-two seeds, air
 * pinned, seam0" and does not say WHICH thirty-two, and neither does
 * PRIORITIES.md, this file, or any script in the tree - searched. The seed set
 * decides every range, so a verdict quoted without it is not a measurement.
 *
 * 1..32 is therefore the named standard from here on. It is a NEW standard,
 * not a recovery of the old one: with these seeds the historical "78 of 78"
 * does not reproduce - this file reads 68/72 with the air off and 66/72 with
 * it on, and those OUTSIDE lines predate the change that was being judged when
 * they were found. They are listed in PRIORITIES rather than carried silently.
 */
const ENVELOPE_SEEDS = Array.from({ length: 32 }, (_, i) => i + 1);
const SEEDS = args.filter((a) => !a.startsWith('--')).map(Number);
const SEEDS_PINNED = SEEDS.length === 0;
if (SEEDS_PINNED) SEEDS.push(...ENVELOPE_SEEDS);

const base = new URL(CORE + '/', import.meta.url);
const { init, step, HALF_X, HALF_Z, UNITS } = await import(new URL('sim.js', base).pathname);
const { frontlineZ } = await import(new URL('rules/frontline.js', base).pathname);
const L = await import(new URL('state.js', base).pathname);

/**
 * Whether the loaded core has an air arm at all.
 *
 * The helicopter slots are the tell: `O_HELIS` was appended to the layout with
 * the air, so a core taken from before it does not have the word.
 */
const AIR = typeof L.O_HELIS !== 'number' ? 'off' : AIROFF ? 'off(pinned)' : 'on';

/**
 * Hold both sortie clocks so far out that no sortie ever launches.
 *
 * `--core=` from a pre-air commit was the only way to do this, which meant
 * comparing two different cores and calling the difference "the air". The
 * clocks are STATE WORDS at `O_AIR + AIR_BULL/AIR_BEAR`, counted down by
 * `TICK_DT` each step - writing `st.heliClock`, which is what an earlier
 * version of this reasoning did, sets a property nothing reads, and every
 * "air off" caption printed that way was wrong. Re-pinned every step because
 * the core rewrites the clock when a sortie would have gone.
 */
const pinAir = AIROFF && typeof L.O_AIR === 'number'
  ? (st) => { st.i32[L.O_AIR + L.AIR_BULL] = 0x40000000;
              st.i32[L.O_AIR + L.AIR_BEAR] = 0x40000000; }
  : () => {};
const COND = (SEAM0 ? ' seam0' : '') + ' air=' + AIR;

const Q = 65536;
// TAKEN FROM THE LAYOUT, never typed. These were literals until the truck
// block grew its thirteenth word and `O_UNITS` moved from 24 to 25 - after
// which this tool read every unit field one word out and reported 0/0 living
// units with a straight face. A measuring tool that prints zeroes is worse
// than one that throws.
const { O_UNITS, U_WORDS, U_X, U_Z, U_SIDE, U_HP, U_STATE } = L;
const SQUADS = 8;
const RANGE = 46;                 // Army.ArmourRange, and ARMOUR_RANGE in the core

const b = (i) => O_UNITS + i * U_WORDS;
const isArmour = (i) => (i & 3) === 0;
const squadOf = (i) => (i >> 3) % SQUADS;

/**
 * A state whose frontline sits at z=0, whatever the tape says.
 *
 * frontlineZ returns 0 when the window has no range at all, so a flat tape
 * pins the seam without touching the rule. Measurement only - the core is not
 * changed and the game's tape still moves.
 */
function pinSeam(st) {
  st.tape.fill(st.tape[0]);
  return st;
}

const start = (seed) => (SEAM0 ? pinSeam(init(seed)) : init(seed));

/** Every living unit, in metres, as the C# recording measures them. */
function census(st) {
  const out = [];
  for (let i = 0; i < UNITS; i++) {
    const o = b(i);
    out.push({
      i, squad: squadOf(i), armour: isArmour(i),
      side: st.i32[o + U_SIDE], alive: st.i32[o + U_STATE] !== 0 && st.i32[o + U_HP] > 0,
      x: st.i32[o + U_X] / Q, z: st.i32[o + U_Z] / Q, hp: st.i32[o + U_HP] / Q,
    });
  }
  return out;
}

const stdev = (xs) => {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, c) => a + c, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, c) => a + (c - m) * (c - m), 0) / xs.length);
};
const mean = (xs) => xs.length ? xs.reduce((a, c) => a + c, 0) / xs.length : 0;

/** ArmyReferenceTests.Density and .Concentration, on the core's own units. */
function density(us) {
  const tanks = us.filter((u) => u.armour && u.alive);
  let total = 0, shooters = 0;
  const hits = new Map();
  for (const a of tanks) {
    let c = 0, best = -1, bd = RANGE * RANGE;
    for (const t of tanks) {
      if (t === a || t.side === a.side) continue;
      const dx = t.x - a.x, dz = t.z - a.z, d = dx * dx + dz * dz;
      if (d < RANGE * RANGE) c++;
      if (d < bd) { bd = d; best = t.i; }
    }
    total += c;
    if (best >= 0) { shooters++; hits.set(best, (hits.get(best) || 0) + 1); }
  }
  return {
    inRange: tanks.length ? total / tanks.length : 0,
    xSpread: stdev(tanks.map((u) => u.x)),
    shooters,
    perTarget: hits.size ? shooters / hits.size : 0,
    worst: hits.size ? Math.max(...hits.values()) : 0,
    tanks: tanks.length,
  };
}

const ref = JSON.parse(readFileSync(new URL('../test/vectors/csharp-army.json', import.meta.url), 'utf8'));

/**
 * Which recorded pass the core is being laid beside.
 *
 * The default is the only one that is a fair target: the C# army at the
 * establishment the core fields, WITH its replacement running. The top-level
 * 'reinforce' pass is twice the size, and reading its 38-42 of 48 as something
 * a 24-tank army should hit is the mistake that cost this item four rounds.
 */
const REF_TAG = (args.find((a) => a.startsWith('--ref=')) || '--ref=core-size-reinforce').slice(6);
const refPass = REF_TAG === 'reinforce'
  ? {
      armourPerSide: ref.armourPerSide, infantryPerSide: ref.infantryPerSide, rows: ref.rows,
      density: ref.density.inRangePerTank.map((v, i) => ({
        t: Math.imul(i, ref.density.sampleSeconds), inRange: v, xSpread: ref.density.xSpread[i],
        shooters: ref.density.shooters[i], tanksAlive: ref.density.tanksAlive[i],
        lost: ref.density.lost[i], arrived: ref.density.arrived[i],
      })),
    }
  : ref.passes[REF_TAG];
if (!refPass) throw new Error('no recorded pass called ' + REF_TAG);

const refAt = (t) => refPass.rows.find((r) => Math.abs(r.t - t) < 0.01);
const refDensity = (t) => refPass.density.find((d) => Math.abs(d.t - t) < 0.01) || {};

const MARKS = [0, 5, 10, 15, 20, 25, 30, 40, 50, 60, 75, 90];
/** A tick and a bit, so a transition landing on a sample boundary counts. */
const EPS = 1 / 30;

function measure(seed) {
  const summary = { seed, marks: {}, deaths: 0, contactLostAt: null, lastDeath: null };
  const st = start(seed);

  const spawn = census(st);
  console.log('ARMYCORE BEGIN  seed=' + seed + COND);
  console.log(`ARMYCORE establishment armour=${spawn.filter((u) => u.armour).length} ` +
              `(bull ${spawn.filter((u) => u.armour && u.side < 0).length}, ` +
              `bear ${spawn.filter((u) => u.armour && u.side > 0).length}) ` +
              `infantry=${spawn.filter((u) => !u.armour).length} ` +
              `(bull ${spawn.filter((u) => !u.armour && u.side < 0).length}, ` +
              `bear ${spawn.filter((u) => !u.armour && u.side > 0).length})`);
  console.log(`ARMYCORE reference '${REF_TAG}': armour ${refPass.armourPerSide}/side ` +
              `infantry ${refPass.infantryPerSide}/side` +
              (refPass.armourPerSide === 12 ? ' - the core\'s own establishment' : ' - NOT the core\'s size'));

  let t = 0;
  for (const mark of MARKS) {
    while (t < mark) { pinAir(st); step(st, 0, 0, 0, 0, 0); t += 1 / 60; }
    const us = census(st);
    const d = density(us);
    const seam = frontlineZ(st.tape, st.i32[5], HALF_X, HALF_Z) / Q;

    const r = refAt(mark);
    const rd = refDensity(mark);

    summary.marks[mark] = {
      shooters: d.shooters, tanks: d.tanks, inRange: d.inRange,
      bull: us.filter((u) => u.armour && u.side < 0 && u.alive).length,
      bear: us.filter((u) => u.armour && u.side > 0 && u.alive).length,
    };

    // The same numbers the lines below PRINT, kept so the envelope verdict at
    // the bottom is computed from them rather than read off the text. It used
    // to be read off the text: "78 of 78" was a person comparing 144 lines by
    // eye, which is exactly the judgement this file exists to replace.
    for (const side of [-1, 1]) {
      const nm = side < 0 ? 'bull' : 'bear';
      const arm = us.filter((u) => u.armour && u.side === side);
      const inf = us.filter((u) => !u.armour && u.side === side);
      const aA = arm.filter((u) => u.alive), iA = inf.filter((u) => u.alive);
      summary.marks[mark][nm + 'ArmourN'] = aA.length;
      summary.marks[mark][nm + 'ArmourZ'] = mean(aA.map((u) => u.z - seam));
      summary.marks[mark][nm + 'ArmourSd'] = stdev(aA.map((u) => u.z));
      summary.marks[mark][nm + 'InfN'] = iA.length;
      summary.marks[mark][nm + 'InfZ'] = mean(iA.map((u) => u.z - seam));
      summary.marks[mark][nm + 'InfSd'] = stdev(iA.map((u) => u.z));
    }
    summary.marks[mark].xspread = d.xSpread;
    summary.marks[mark].perTarget = d.perTarget;
    summary.marks[mark].worst = d.worst;

    for (const side of [-1, 1]) {
      const name = side < 0 ? 'bull' : 'bear';
      const arm = us.filter((u) => u.armour && u.side === side);
      const inf = us.filter((u) => !u.armour && u.side === side);
      const aAlive = arm.filter((u) => u.alive), iAlive = inf.filter((u) => u.alive);
      const refArm = r ? r[name + 'Armour'] : null;
      const refInf = r ? r[name + 'Inf'] : null;
      console.log(
        `ARMYCORE t=${mark.toFixed(0).padStart(2)} ${name} ` +
        `armour ${aAlive.length}/${arm.length} (${(100 * aAlive.length / arm.length).toFixed(0)}%)` +
        ` z=${mean(aAlive.map((u) => u.z - seam)).toFixed(1)} sd=${stdev(aAlive.map((u) => u.z)).toFixed(1)}` +
        `  inf ${iAlive.length}/${inf.length} (${(100 * iAlive.length / inf.length).toFixed(0)}%)` +
        ` z=${mean(iAlive.map((u) => u.z - seam)).toFixed(1)}` +
        // The infantry's SPREAD, which this line used to leave out on both
        // sides although the recording carries it per row. It is the whole of
        // (q): the men march in lockstep for the first half-minute and
        // over-spread later, and spread decides who stands inside a 16 m
        // blast. A comparison that prints the mean and drops the spread hides
        // exactly the quantity in question.
        ` sd=${stdev(iAlive.map((u) => u.z)).toFixed(1)}` +
        (refArm ? `   | REC armour ${refArm.n}/${refPass.armourPerSide} (${(100 * refArm.n / refPass.armourPerSide).toFixed(0)}%)` +
          ` z=${refArm.z.toFixed(1)} sd=${refArm.spread.toFixed(1)}` +
          `  inf ${refInf.n}/${refPass.infantryPerSide} (${(100 * refInf.n / refPass.infantryPerSide).toFixed(0)}%)` +
          ` z=${refInf.z.toFixed(1)} sd=${refInf.spread.toFixed(1)}` : ''));
    }

    // The question this file exists for: WHERE the dead are.
    for (const side of [-1, 1]) {
      const name = side < 0 ? 'bull' : 'bear';
      const cells = [];
      for (let sq = 0; sq < SQUADS; sq++) {
        const arm = us.filter((u) => u.armour && u.side === side && u.squad === sq);
        const alive = arm.filter((u) => u.alive);
        const xs = alive.map((u) => u.x);
        cells.push(`${sq}:${alive.length}/${arm.length}` +
                   (alive.length ? `@${mean(xs).toFixed(0)}` : '@--'));
      }
      console.log(`ARMYCORE t=${mark.toFixed(0).padStart(2)} ${name} squads(armour alive/est@meanX) ` + cells.join(' '));
    }

    console.log(`ARMYCORE t=${mark.toFixed(0).padStart(2)} density inRange=${d.inRange.toFixed(2)} ` +
                `xspread=${d.xSpread.toFixed(1)} shooters=${d.shooters} tanksAlive=${d.tanks} ` +
                `perTarget=${d.perTarget.toFixed(2)} worst=${d.worst} seam=${seam.toFixed(1)}` +
                (rd.inRange !== undefined
                  ? `   | REC inRange=${rd.inRange} xspread=${rd.xSpread} shooters=${rd.shooters} ` +
                    // perTarget and worst were held back on the recording's side
                    // although the rows carry them. A comparison that prints a
                    // quantity for one engine only is not a comparison.
                    `tanksAlive=${rd.tanksAlive} perTarget=${rd.perTarget} worst=${rd.worst} ` +
                    `lost=${rd.lost} arrived=${rd.arrived}`
                  : ''));

    // The armour's |x| in bands, beside the reference's own.
    //
    // This is the pair (o) was blocked on. `xspread` is a standard deviation
    // and cannot tell a peak with stragglers from a flat spread, so the core
    // matched it to within a metre while a share read off the courier pass
    // said the two shapes were nothing alike. The reference now publishes the
    // bands; nothing has to be inferred from a denominator again.
    if (rd.xBands) {
      const EDGES = [10, 20, 31, 45, 60, 80];
      const NAMES = ['<10', '<20', '<31', '<45', '<60', '<80', '80+'];
      const mine = new Array(NAMES.length).fill(0);
      const living = us.filter((u) => u.armour && u.alive);
      for (const u of living) {
        const ax = Math.abs(u.x);
        let b = EDGES.length;
        for (let i = 0; i < EDGES.length; i++) if (ax < EDGES[i]) { b = i; break; }
        mine[b]++;
      }
      const pct = (v, n) => (n ? (100 * v / n).toFixed(0) : '0').padStart(3);
      const refN = rd.xBandsOf;
      console.log(`ARMYCORE t=${mark.toFixed(0).padStart(2)} xbands core ` +
        NAMES.map((k, i) => `${k}:${pct(mine[i], living.length)}%`).join(' ') +
        `  of ${living.length}`);
      console.log(`ARMYCORE t=${mark.toFixed(0).padStart(2)} xbands  REC ` +
        NAMES.map((k) => `${k}:${pct(rd.xBands[k], refN)}%`).join(' ') +
        `  of ${refN}`);
    }
  }
  console.log('ARMYCORE END');

  // -------------------------------------------------------------------------
  // Second pass: WHERE and WHEN each tank died, and whether the board stops.
  //
  // The per-squad grid above is sampled at five-second marks and squad index is
  // not ordered by x, so neither one can settle survivorship on its own. This
  // re-runs the same seed and records every armour death as it happens: the
  // second it died, its squad, and the x it was standing on. Losses banded by x
  // is the discriminator - survivorship puts the dead in the middle of the front
  // and leaves the flanks, drift kills evenly and merely separates the living.
  const st2 = start(seed);
  const wasAlive = new Array(UNITS).fill(true);
  /** Last tick's hit points per slot: a living tank never gains any. */
  const hp = new Array(UNITS).fill(0);
  const at = (i) => {
    const o = b(i);
    return { x: st2.i32[o + U_X] / Q, z: st2.i32[o + U_Z] / Q, hp: st2.i32[o + U_HP] / Q,
             alive: st2.i32[o + U_STATE] !== 0 && st2.i32[o + U_HP] > 0 };
  };
  for (let i = 0; i < UNITS; i++) if (isArmour(i)) hp[i] = at(i).hp;
  const deaths = [];
  const arrivals = [];
  const spawnX = {};
  for (let i = 0; i < UNITS; i++) if (isArmour(i)) spawnX[i] = at(i).x;

  // Cumulative losses and arrivals at each mark, which is the pair the
  // recording is read on: a headcount alone cannot tell an army that is not
  // dying from one that is dying and being replaced.
  const ledger = {};

  /** Living armour, and the distance from each to its nearest enemy. */
  const contact = () => {
    const live = [];
    for (let i = 0; i < UNITS; i++) if (isArmour(i) && at(i).alive) live.push({ i, ...at(i), side: st2.i32[b(i) + U_SIDE] });
    let best = Infinity;
    for (const u of live) for (const v of live) {
      if (v.side === u.side) continue;
      best = Math.min(best, Math.hypot(v.x - u.x, v.z - u.z));
    }
    return best;
  };

  let prev = null, moveAt = {};
  if (!QUIET) console.log('ARMYCORE DEATHS BEGIN (armour only: t, side, squad, x, z)');
  for (let f = 0; f < 90 * 60; f++) {
    const before = {};
    for (let i = 0; i < UNITS; i++) if (isArmour(i) && wasAlive[i]) before[i] = at(i);
    pinAir(st2); step(st2, 0, 0, 0, 0, 0);
    const tNow = (f + 1) / 60;
    for (let i = 0; i < UNITS; i++) {
      if (!isArmour(i)) continue;
      const u = at(i);
      const side = st2.i32[b(i) + U_SIDE];
      const died = () => deaths.push({ t: tNow, i, side, squad: squadOf(i),
                                       x: before[i] ? before[i].x : u.x,
                                       z: before[i] ? before[i].z : u.z, spawnX: spawnX[i] });
      // A slot refilled. The index fixes the side and the arm, so a
      // replacement always joins the army that lost the tank.
      const arrived = () => arrivals.push({ t: tNow, i, side });

      if (wasAlive[i] && !u.alive) { wasAlive[i] = false; died(); }
      else if (!wasAlive[i] && u.alive) { wasAlive[i] = true; arrived(); }
      else if (u.alive && u.hp > hp[i]) {
        // Alive at both ends of the tick and HEALED, which nothing in the
        // army does: this slot lost its tank and was refilled in the same
        // tick - reinforce() runs after the shooting and takes the first free
        // slot, which can be the one that just emptied. Counting only the
        // state flag missed both events and made the vehicle look like it had
        // moved a hundred and sixteen metres in a second.
        died(); arrived();
      }
      hp[i] = u.hp;
    }
    if ((f + 1) % 60 === 0) ledger[Math.round(tNow)] = { lost: deaths.length, arrived: arrivals.length };
    // Once per second: is anyone still within gun range of an enemy, and does
    // anything still move? The first is why the shooting stops; the second
    // says whether the survivors are walking anywhere or standing on a post.
    if ((f + 1) % 60 === 0) {
      const gap = contact();
      if (summary.contactLostAt === null && gap > RANGE && deaths.length > 0) summary.contactLostAt = tNow;
      if (gap <= RANGE) summary.contactLostAt = null;

      // Per SLOT, not per position in a list of the living. With replacement
      // running, the list's membership changes between samples, so comparing
      // by position measured the distance from one tank to a different one and
      // reported a hundred and thirty-five metres in a second - a respawn at
      // the map edge, read as movement. Slots that arrived inside the window
      // are skipped for the same reason.
      const now = {};
      for (let i = 0; i < UNITS; i++) if (isArmour(i) && wasAlive[i]) now[i] = at(i);
      // Comparable only if the slot held the same tank for the whole second.
      // Anything that died or was refilled inside the window is a different
      // vehicle at the two ends of it.
      const born = new Set();
      for (const a of arrivals) if (a.t > tNow - 1 - EPS) born.add(a.i);
      for (const d of deaths) if (d.t > tNow - 1 - EPS) born.add(d.i);
      if (prev) {
        let moved = 0;
        for (const i of Object.keys(now)) {
          if (!prev[i] || born.has(Number(i))) continue;
          moved = Math.max(moved, Math.abs(now[i].x - prev[i].x) + Math.abs(now[i].z - prev[i].z));
        }
        moveAt[tNow] = moved;
      }
      prev = now;
    }
  }
  if (!QUIET) {
    for (const d of deaths) {
      console.log(`ARMYCORE death t=${d.t.toFixed(2).padStart(5)} ${d.side < 0 ? 'bull' : 'bear'} ` +
                  `squad=${d.squad} x=${d.x.toFixed(0).padStart(4)} z=${d.z.toFixed(0).padStart(4)} ` +
                  `spawnX=${d.spawnX.toFixed(0).padStart(4)}`);
    }
  }
  console.log('ARMYCORE DEATHS END  total=' + deaths.length + ' of ' +
              Object.keys(spawnX).length + ' armour, arrivals=' + arrivals.length);
  console.log('ARMYCORE ledger (cumulative armour lost/arrived) ' +
              MARKS.filter((m) => ledger[m]).map((m) => `t=${m}:${ledger[m].lost}/${ledger[m].arrived}`).join(' '));
  summary.deaths = deaths.length;
  summary.arrivals = arrivals.length;
  summary.ledger = ledger;
  summary.lastDeath = deaths.length ? deaths[deaths.length - 1].t : null;

  // Losses banded by the x each tank was standing on when it died, and by the
  // x it spawned on. Bands are the 176 m front cut into four.
  //
  // Both bandings count the SAME quantity in the denominator - the tanks that
  // began the round in that band - because that is the only establishment a
  // band has. Banding the dead by where they fell and the living by where they
  // started printed lines like "lost 4/0"; the two keys are now reported apart.
  const band = (x) => (x < -44 ? '[-88,-44)' : x < 0 ? '[-44,0)' : x < 44 ? '[0,44)' : '[44,88]');
  const BANDS = ['[-88,-44)', '[-44,0)', '[0,44)', '[44,88]'];
  for (const side of [-1, 1]) {
    const name = side < 0 ? 'bull' : 'bear';
    const est = {};
    for (let i = 0; i < UNITS; i++) {
      if (!isArmour(i) || st2.i32[b(i) + U_SIDE] !== side) continue;
      est[band(spawnX[i])] = (est[band(spawnX[i])] || 0) + 1;
    }
    const lostBySpawn = {}, fellIn = {};
    for (const d of deaths) if (d.side === side) {
      lostBySpawn[band(d.spawnX)] = (lostBySpawn[band(d.spawnX)] || 0) + 1;
      fellIn[band(d.x)] = (fellIn[band(d.x)] || 0) + 1;
    }
    console.log(`ARMYCORE losses-by-spawn-band ${name} ` +
      BANDS.map((bd) => `${bd} lost ${lostBySpawn[bd] || 0}/${est[bd] || 0}`).join('  '));
    console.log(`ARMYCORE fell-in-band ${name} ` +
      BANDS.map((bd) => `${bd} ${fellIn[bd] || 0}`).join('  ') + '   (where the dead were standing)');
  }

  const moveMarks = [30, 45, 60, 75, 90].filter((m) => moveAt[m] !== undefined);
  console.log('ARMYCORE movement (largest metres any living tank covered in the previous second) ' +
              moveMarks.map((m) => `t=${m}:${moveAt[m].toFixed(2)}`).join(' '));
  console.log('ARMYCORE contact: last death t=' +
              (summary.lastDeath === null ? 'none' : summary.lastDeath.toFixed(1)) +
              ', nearest enemy stayed outside the ' + RANGE + ' m gun from t=' +
              (summary.contactLostAt === null ? 'never - contact held' : summary.contactLostAt.toFixed(0)));

  // -------------------------------------------------------------------------
  // Which squad columns each side still holds, and how far the nearest enemy is.
  //
  // Squad anchors run -76 to +76, so columns are 21.7 m apart and the 46 m gun
  // reaches about two columns either way. If the two sides' surviving columns do
  // not overlap within two, no shot is possible however many tanks are alive -
  // which is a THIRD reading, distinct from both survivorship and drift.
  const st3 = start(seed);
  let t3 = 0;
  for (const mark of [20, 30, 40, 60]) {
    while (t3 < mark) { pinAir(st3); step(st3, 0, 0, 0, 0, 0); t3 += 1 / 60; }
    const live = [];
    for (let i = 0; i < UNITS; i++) {
      if (!isArmour(i)) continue;
      const o = b(i);
      if (st3.i32[o + U_STATE] === 0 || st3.i32[o + U_HP] <= 0) continue;
      live.push({ i, squad: squadOf(i), side: st3.i32[o + U_SIDE],
                  x: st3.i32[o + U_X] / Q, z: st3.i32[o + U_Z] / Q });
    }
    for (const side of [-1, 1]) {
      const mine = live.filter((u) => u.side === side);
      const cols = [...new Set(mine.map((u) => u.squad))].sort((a, c) => a - c);
      console.log(`ARMYCORE t=${String(mark).padStart(2)} ${side < 0 ? 'bull' : 'bear'} ` +
                  `holds columns [${cols.join(',')}] with ${mine.length} tanks`);
    }
    const ds = live.map((u) => {
      let best = Infinity;
      for (const v of live) {
        if (v.side === u.side) continue;
        const d = Math.hypot(v.x - u.x, v.z - u.z);
        if (d < best) best = d;
      }
      return { u, best };
    });
    console.log(`ARMYCORE t=${String(mark).padStart(2)} nearest-enemy per living tank: ` +
      ds.map((d) => `${d.u.side < 0 ? 'B' : 'R'}sq${d.u.squad}@${d.u.x.toFixed(0)}:` +
                    `${d.best === Infinity ? 'none' : d.best.toFixed(0)}`).join(' ') +
      `   (range ${RANGE})`);
  }

  return summary;
}

const all = SEEDS.map(measure);

// One line per seed, because the figures in PRIORITIES.md - "17-67% against
// 71-83%" - are ranges ACROSS seeds and a single seed cannot be compared to
// them at all.
console.log('');
console.log('ARMYCORE SUMMARY' + (SEAM0 ? ' (seam pinned at 0, the recording\'s condition)' : ' (seam where the tape puts it)')
            + (AIR === 'on'
               ? '  AIR=ON - the recording is air-off, so the loss columns are NOT like for like; --core= a pre-air worktree for that'
               : '  AIR=OFF - the recording\'s own condition'));
for (const s of all) {
  const at = (m) => s.marks[m];
  console.log(`ARMYCORE summary seed=${String(s.seed).padStart(9)} ` +
    `armour bull/bear t=15 ${at(15).bull}/${at(15).bear}  t=30 ${at(30).bull}/${at(30).bear}  ` +
    `t=60 ${at(60).bull}/${at(60).bear}  t=90 ${at(90).bull}/${at(90).bear}  ` +
    `shooters t=20/40/60/90 ${at(20).shooters}/${at(40).shooters}/${at(60).shooters}/${at(90).shooters}  ` +
    `lost/arrived=${s.deaths}/${s.arrivals}  ` +
    `contact lost from t=${s.contactLostAt === null ? '-' : s.contactLostAt.toFixed(0)}`);
}
// ---------------------------------------------------------------------------
// THE ENVELOPE VERDICT.
//
// Until this existed the "78 of 78" in PRIORITIES.md was a person reading 144
// printed lines. That is the judgement this file exists to replace, so the
// verdict is computed: for every published quantity, the core's range ACROSS
// SEEDS against the recording's value at the same mark. The recording is one
// run per configuration - it carries no [lo, hi] of its own, unlike
// `csharp-gunships.json` - so the test is the discipline this project already
// uses in prose: THE RECORDING MUST LIE INSIDE THE CORE'S RANGE.
//
// Sample width is not a detail here. At sixteen seeds `worst` at t=30 and the
// 46 m density at t=90 have both read OUTSIDE and both are inside at
// thirty-two; the width is printed with the verdict so a run can never be
// quoted without it.
const VMARKS = [15, 30, 60, 90];
const QUANT = [];
for (const m of VMARKS) {
  for (const nm of ['bull', 'bear']) {
    const r = refAt(m);
    if (!r) continue;
    const ra = r[nm + 'Armour'], ri = r[nm + 'Inf'];
    QUANT.push([`t=${m} ${nm} armour alive`, m, nm + 'ArmourN', ra.n]);
    QUANT.push([`t=${m} ${nm} armour z`,     m, nm + 'ArmourZ', ra.z]);
    QUANT.push([`t=${m} ${nm} armour sd`,    m, nm + 'ArmourSd', ra.spread]);
    QUANT.push([`t=${m} ${nm} inf alive`,    m, nm + 'InfN', ri.n]);
    QUANT.push([`t=${m} ${nm} inf z`,        m, nm + 'InfZ', ri.z]);
    QUANT.push([`t=${m} ${nm} inf sd`,       m, nm + 'InfSd', ri.spread]);
  }
  const rd = refDensity(m);
  if (rd && rd.inRange !== undefined) {
    QUANT.push([`t=${m} density inRange`, m, 'inRange', rd.inRange]);
    QUANT.push([`t=${m} density xspread`, m, 'xspread', rd.xSpread]);
    QUANT.push([`t=${m} density shooters`, m, 'shooters', rd.shooters]);
    QUANT.push([`t=${m} density tanksAlive`, m, 'tanks', rd.tanksAlive]);
    QUANT.push([`t=${m} density perTarget`, m, 'perTarget', rd.perTarget]);
    QUANT.push([`t=${m} density worst`, m, 'worst', rd.worst]);
  }
}

console.log('');
console.log(`ARMYCORE ENVELOPE  core [lo, hi] across ${all.length} seeds` +
            `   vs   csharp-army.json, pass '${REF_TAG}'   (${COND.trim()})`);
console.log(`ARMYCORE env seeds ${SEEDS_PINNED ? '1..32, the pinned standard' : SEEDS.join(',') + ' - GIVEN ON THE COMMAND LINE, not the pinned set'}`);
let inside = 0;
for (const [label, mark, key, ref] of QUANT) {
  const vals = all.map((s2) => s2.marks[mark] && s2.marks[mark][key])
                  .filter((v) => typeof v === 'number' && !Number.isNaN(v));
  if (!vals.length) continue;
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const ok = ref >= lo && ref <= hi;
  if (ok) inside++;
  console.log(`ARMYCORE env ${label.padEnd(26)} core [${lo.toFixed(2)}, ${hi.toFixed(2)}]`.padEnd(70) +
              ` rec ${Number(ref).toFixed(2)}  ${ok ? 'OVERLAPS' : 'OUTSIDE'}`);
}
// The denominator is fixed by construction - four marks, two sides, six
// figures each, plus six density figures a mark - so N/M can be compared
// between runs. If a mark ever goes missing from the recording the count
// would silently shrink, so it is asserted rather than trusted.
if (QUANT.length !== 72)
  console.log(`ARMYCORE env WARNING check list is ${QUANT.length}, not the 72 this denominator assumes`);
console.log(`ARMYCORE ENVELOPE ${inside}/${QUANT.length} quantities contain the recording` +
            `   (${all.length} seeds${SEEDS_PINNED ? ', pinned 1..32' : ', NOT the pinned set'}` +
            ` - at sixteen this file has read OUTSIDE where thirty-two reads inside)`);

const rEnd = refPass.density[refPass.density.length - 1];
console.log(`ARMYCORE reference '${REF_TAG}' for the same rows: ` +
  `alive ${refPass.density.filter((d) => d.t >= 15).map((d) => d.tanksAlive).join(',')} ` +
  `| shooters ${refPass.density.filter((d) => d.t >= 15).map((d) => d.shooters).join(',')} ` +
  `| lost/arrived at t=90 ${rEnd.lost}/${rEnd.arrived}`);
