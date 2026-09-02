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
//     node tools/measure-army.js [seed ...] [--seam0] [--quiet]
//
// --seam0 pins the frontline at z=0, which is the condition the C# recording
// was made under (ArmyReferenceTests sets FrontlineAt = _ => 0). Without it
// the seam sits where the price tape puts it - +27.3 m - and the two armies
// start 105 m and 51 m from the line respectively, which is not the fight the
// recording holds. Any number compared against the recording wants this flag.
//
// --quiet drops the per-death list and prints the marks and the summary only.
import { readFileSync } from 'node:fs';
import { init, step, HALF_X, HALF_Z, UNITS } from '../src/sim.js';
import { frontlineZ } from '../src/rules/frontline.js';

const Q = 65536;
const O_UNITS = 24, U_WORDS = 8;
const U_X = 0, U_Z = 1, U_SIDE = 2, U_HP = 3, U_STATE = 5;
const SQUADS = 8;
const RANGE = 46;                 // Army.ArmourRange, and ARMOUR_RANGE in the core

const b = (i) => O_UNITS + i * U_WORDS;
const isArmour = (i) => (i & 3) === 0;
const squadOf = (i) => (i >> 3) % SQUADS;

const args = process.argv.slice(2);
const SEAM0 = args.includes('--seam0');
const QUIET = args.includes('--quiet');
const SEEDS = args.filter((a) => !a.startsWith('--')).map(Number);
if (SEEDS.length === 0) SEEDS.push(1);

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
const refAt = (t) => ref.rows.find((r) => Math.abs(r.t - t) < 0.01);
const refDensity = (t) => ({
  inRange: ref.density.inRangePerTank[Math.round(t / ref.density.sampleSeconds)],
  xSpread: ref.density.xSpread[Math.round(t / ref.density.sampleSeconds)],
});
// The recording's density series stops here. Anything the core reports past
// this mark - and the shooter collapse is at t=60 - has NOTHING to be held
// against until ArmyReferenceTests records that far.
const REF_DENSITY_END = (ref.density.inRangePerTank.length - 1) * ref.density.sampleSeconds;

const MARKS = [0, 5, 10, 15, 20, 25, 30, 40, 50, 60, 75, 90];

function measure(seed) {
  const summary = { seed, marks: {}, deaths: 0, contactLostAt: null, lastDeath: null };
  const st = start(seed);

  const spawn = census(st);
  console.log('ARMYCORE BEGIN  seed=' + seed + (SEAM0 ? ' seam0' : ''));
  console.log(`ARMYCORE establishment armour=${spawn.filter((u) => u.armour).length} ` +
              `(bull ${spawn.filter((u) => u.armour && u.side < 0).length}, ` +
              `bear ${spawn.filter((u) => u.armour && u.side > 0).length}) ` +
              `infantry=${spawn.filter((u) => !u.armour).length} ` +
              `(bull ${spawn.filter((u) => !u.armour && u.side < 0).length}, ` +
              `bear ${spawn.filter((u) => !u.armour && u.side > 0).length})`);
  console.log('ARMYCORE recording establishment armour=' + ref.armourPerSide + '/side infantry=' +
              ref.infantryPerSide + '/side   <- HALF AGAIN as many per side as the core has');

  let t = 0;
  for (const mark of MARKS) {
    while (t < mark) { step(st, 0, 0, 0, 0, 0); t += 1 / 60; }
    const us = census(st);
    const d = density(us);
    const seam = frontlineZ(st.tape, st.i32[5], HALF_X, HALF_Z) / Q;

    const r = refAt(Math.round(mark / 5) * 5 <= 90 ? mark : 90);
    const rd = mark <= REF_DENSITY_END ? refDensity(mark) : {};

    summary.marks[mark] = {
      shooters: d.shooters, tanks: d.tanks, inRange: d.inRange,
      bull: us.filter((u) => u.armour && u.side < 0 && u.alive).length,
      bear: us.filter((u) => u.armour && u.side > 0 && u.alive).length,
    };

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
        (refArm ? `   | REC armour ${refArm.n}/${ref.armourPerSide} (${(100 * refArm.n / ref.armourPerSide).toFixed(0)}%)` +
          ` z=${refArm.z.toFixed(1)} sd=${refArm.spread.toFixed(1)}` +
          `  inf ${refInf.n}/${ref.infantryPerSide} (${(100 * refInf.n / ref.infantryPerSide).toFixed(0)}%)` : ''));
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
                  ? `   | REC inRange=${rd.inRange} xspread=${rd.xSpread}`
                  : `   | REC none recorded past t=${REF_DENSITY_END}`));
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
  const at = (i) => {
    const o = b(i);
    return { x: st2.i32[o + U_X] / Q, z: st2.i32[o + U_Z] / Q,
             alive: st2.i32[o + U_STATE] !== 0 && st2.i32[o + U_HP] > 0 };
  };
  const deaths = [];
  const spawnX = {};
  for (let i = 0; i < UNITS; i++) if (isArmour(i)) spawnX[i] = at(i).x;

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
    step(st2, 0, 0, 0, 0, 0);
    const tNow = (f + 1) / 60;
    for (let i = 0; i < UNITS; i++) {
      if (!isArmour(i) || !wasAlive[i]) continue;
      if (!at(i).alive) {
        wasAlive[i] = false;
        deaths.push({ t: tNow, i, side: st2.i32[b(i) + U_SIDE], squad: squadOf(i),
                      x: before[i].x, z: before[i].z, spawnX: spawnX[i] });
      }
    }
    // Once per second: is anyone still within gun range of an enemy, and does
    // anything still move? The first is why the shooting stops; the second
    // says whether the survivors are walking anywhere or standing on a post.
    if ((f + 1) % 60 === 0) {
      const gap = contact();
      if (summary.contactLostAt === null && gap > RANGE && deaths.length > 0) summary.contactLostAt = tNow;
      if (gap <= RANGE) summary.contactLostAt = null;

      const now = [];
      for (let i = 0; i < UNITS; i++) if (isArmour(i) && wasAlive[i]) now.push(at(i));
      if (prev && prev.length === now.length) {
        let moved = 0;
        for (let k = 0; k < now.length; k++) moved = Math.max(moved, Math.abs(now[k].x - prev[k].x) + Math.abs(now[k].z - prev[k].z));
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
              Object.keys(spawnX).length + ' armour');
  summary.deaths = deaths.length;
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
    while (t3 < mark) { step(st3, 0, 0, 0, 0, 0); t3 += 1 / 60; }
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
console.log('ARMYCORE SUMMARY' + (SEAM0 ? ' (seam pinned at 0, the recording\'s condition)' : ' (seam where the tape puts it)'));
for (const s of all) {
  const at = (m) => s.marks[m];
  console.log(`ARMYCORE summary seed=${String(s.seed).padStart(9)} ` +
    `armour bull/bear t=15 ${at(15).bull}/${at(15).bear}  t=30 ${at(30).bull}/${at(30).bear}  ` +
    `t=60 ${at(60).bull}/${at(60).bear}  t=90 ${at(90).bull}/${at(90).bear}  ` +
    `shooters t=20/40/60 ${at(20).shooters}/${at(40).shooters}/${at(60).shooters}  ` +
    `deaths=${s.deaths} last=${s.lastDeath === null ? '-' : s.lastDeath.toFixed(0)}s  ` +
    `contact lost from t=${s.contactLostAt === null ? '-' : s.contactLostAt.toFixed(0)}`);
}
console.log('ARMYCORE recording, for the same rows: armour 24/side, survivors 79-88% at t=15-60. ' +
            'The core fields 12/side, so neither the percentages nor the shooter counts are ' +
            'comparable until the two armies are the same size.');
