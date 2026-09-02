// The core's air arm, laid beside test/vectors/csharp-gunships.json.
//
// Same job as tools/measure-army.js and for the same reason: the recording is
// the specification for item 2d's second half, and a port that has not been
// held against it has only been read. The C# harness could not be matched to
// the digit and says so - its sortie clock and its gunship direction are on
// UnityEngine.Random, not on the army seed - so what is compared here is the
// ENVELOPE across four seeds, which is what the recording published.
//
//     node tools/measure-air.js [seed ...] [--seam0] [--bombs] [--core=DIR]
//
// --seam0 pins the frontline at z=0, which is the condition the recording was
// made under (GunshipReferenceTests sets FrontlineAt = _ => 0). Any number
// compared against it wants this flag.
//
// --bombs prints one line per detonation, in the recording's own shape.
//
// --core=DIR loads the core from somewhere else, which is how the no-air
// control is produced. The core has no switch for turning the air off and
// should not grow one - a rule that can be disabled at runtime is a rule two
// implementations can disagree about - so the control is the core as it was
// before the air landed:
//
//     git worktree add /tmp/noair <commit-before-the-air>
//     node tools/measure-air.js --seam0 --core=/tmp/noair/packages/core/src
//
// It prints zeros for everything air and real numbers for armour lost and the
// exit headcounts, which is the pair the recording's finding 6 turns on: air
// changes who dies, not how the round ends.
//
// Prints; asserts nothing.

import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const SEAM0 = args.includes('--seam0');
const BOMBS = args.includes('--bombs');
const CORE = (args.find((a) => a.startsWith('--core=')) || '--core=../src').slice(7);
const SEEDS = args.filter((a) => !a.startsWith('--')).map(Number);
if (SEEDS.length === 0) SEEDS.push(20260901, 20260902, 20260903, 20260904);

const base = new URL(CORE + '/', import.meta.url);
const sim = await import(new URL('sim.js', base).pathname);
const L = await import(new URL('state.js', base).pathname);
const { init, step, UNITS, HALF_X, HALF_Z } = sim;

/** True once the loaded core has an air arm at all, so the control run works. */
const HAS_AIR = typeof L.O_HELIS === 'number';
const air = HAS_AIR ? await import(new URL('rules/air.js', base).pathname) : null;

const Q = 65536;
const q = (v) => v / Q;
const isArmour = (i) => (i & 3) === 0;

const RADIUS = HAS_AIR ? q(air.BOMB_RADIUS) : 16;
const FRONT_X = 92, HALF_DEPTH = 79;

const army = await import(new URL('rules/army.js', base).pathname);
/** A rifleman's hit points and his reach. Both may be absent in the control. */
const RIFLE_HP = typeof army.RIFLE_HP === 'number' ? q(army.RIFLE_HP) : 10;
const RIFLE_RANGE = typeof army.RIFLE_RANGE === 'number' ? q(army.RIFLE_RANGE) : 26;

/** What the blast is worth to a unit d metres out: the armour falloff, in metres. */
const BOMB_PEAK = HAS_AIR ? q(air.BOMB_DAMAGE) : 120;
const damageAt = (d) => (d >= RADIUS ? 0 : BOMB_PEAK * (1 - d / RADIUS));

/**
 * The ring where the falloff drops to a rifleman's hit points: 16 * (1 - 10/120)
 * = 14.67 m.
 *
 * Nothing in either engine uses it - a bomb does not wound a rifleman, it
 * clears the circle, in Army.Detonate and in sim.js alike. It is here because
 * it is the SAME counter-check the armour line already carries ("could this
 * bomb alone have killed him"), evaluated for a man who holds ten points, and
 * because it splits the circle into the disc a falloff rule would have taken
 * and the 16% of its area it would have left standing. If the core's men sit
 * further out than the recording's, that is where it shows.
 */
const RING = RADIUS * (1 - RIFLE_HP / BOMB_PEAK);

/** Two-metre bands out from the centre, and the share of the area each holds. */
const BAND = 2;
const BANDS = Math.round(RADIUS / BAND);
const bandOf = (d) => Math.min(BANDS - 1, Math.floor(d / BAND));
const bandArea = [...Array(BANDS)].map((_, k) => ((k + 1) ** 2 - k ** 2) / BANDS ** 2);

const ref = JSON.parse(readFileSync(new URL('../test/vectors/csharp-gunships.json', import.meta.url), 'utf8'));

function pinSeam(st) { st.tape.fill(st.tape[0]); return st; }
const start = (seed) => (SEAM0 ? pinSeam(init(seed)) : init(seed));

/** Every unit slot, as the recording measures them. */
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

const helis = (st) => {
  if (!HAS_AIR) return [];
  const out = [];
  for (let i = 0; i < L.MAX_HELIS; i++) {
    const o = L.heliBase(i);
    if (st.i32[o + L.H_STATE] === 0) continue;
    out.push({ i, side: st.i32[o + L.H_SIDE], x: q(st.i32[o + L.H_X]),
               y: q(st.i32[o + L.H_Y]), z: q(st.i32[o + L.H_Z]),
               dir: q(st.i32[o + L.H_DIR]), dropIn: q(st.i32[o + L.H_DROPIN]) });
  }
  return out;
};

const bombSlots = (st) => {
  if (!HAS_AIR) return [];
  const out = [];
  for (let i = 0; i < L.MAX_BOMBS; i++) {
    const o = L.bombBase(i);
    out.push({ live: st.i32[o + L.B_STATE] !== 0, side: st.i32[o + L.B_SIDE],
               x: q(st.i32[o + L.B_X]), y: q(st.i32[o + L.B_Y]), z: q(st.i32[o + L.B_Z]) });
  }
  return out;
};

/**
 * Where a bomb landed, in GunshipReferenceTests.Where's three categories: off
 * the box the armies are held in at all, on the dropper's own side of the seam,
 * or across it where it was aimed.
 */
function where(b) {
  if (Math.abs(b.x) >= FRONT_X || Math.abs(b.z) > HALF_DEPTH) return 'offfield';
  return (b.side < 0 ? b.z > 0 : b.z < 0) ? 'enemy' : 'own';
}

function measure(seed) {
  const st = start(seed);
  const TICKS = 90 * 60;
  const dt = 1092 / Q;

  let sorties = 0, sortiesBull = 0, sortiesBear = 0;
  let airborneSeconds = 0, bombsInAirSeconds = 0, peakAirborne = 0, peakBombs = 0;
  const sortieTimes = { '-1': [], '1': [] };
  const blasts = [];
  // Slots that both died and were refilled inside one tick: their post-step
  // position is the replacement's, not the corpse's. Counted, not hidden.
  let ambiguous = 0;
  let shellKills = 0, riflemenKilled = 0;
  let armourLost = 0, arrived = 0;
  // A tank covered by a blast that the blast alone could not have finished, so
  // a shell in the same tick must have helped. The recording attributes by
  // event order, which nothing outside the core can see.
  let sharedArmourKills = 0;
  // The same counter-check for a rifleman, and the same formula: hit points
  // against the falloff at his distance. He holds ten and the falloff is 120 at
  // the centre, so it is true exactly outside RING - which is why the number is
  // reported beside the ring split rather than instead of it.
  let sharedInfKills = 0;
  // A body inside two circles in one tick. Each bomb claims it, so infKills
  // counts it twice; the C# recorder dedupes on the unit and reports the
  // double-fires separately (doubleFire.infantry, 0 on all four seeds).
  let doubleClaimedInf = 0, doubleClaimedArmour = 0, uniqueInfClaimed = 0;
  // A bound, not an attribution: a claimed man who had an enemy rifleman
  // inside 26 m at the top of the tick is a man a rifle could have taken
  // first. The rifle fires in the unit loop, the bomb in the air phase after
  // it, and from outside the core the two deaths look identical - so this is
  // the largest number of bomb kills that could really be rifle kills.
  let claimedWithRifleInReach = 0;
  const inBands = new Array(BANDS).fill(0), killBands = new Array(BANDS).fill(0);
  let infInInner = 0, infInOuter = 0, infInner = 0, infOuter = 0, blastsMismatched = 0;

  let prev = census(st);
  let prevHelis = helis(st);
  let prevBombs = bombSlots(st);

  for (let f = 0; f < TICKS; f++) {
    step(st, 0, 0, 0, 0, 0);
    const t = (f + 1) * dt;
    const now = census(st);
    const nowHelis = helis(st);
    const nowBombs = bombSlots(st);

    // A sortie is a gunship that was not airborne last tick. Its side and the
    // time are all the recording's sortie lines carry.
    for (const h of nowHelis) {
      if (prevHelis.some((p) => p.i === h.i)) continue;
      sorties++;
      if (h.side < 0) sortiesBull++; else sortiesBear++;
      sortieTimes[String(h.side)].push({ t, x: h.x, z: h.z, dir: h.dir, dropIn: h.dropIn });
    }

    // A detonation is a bomb slot that was live and is now free. The landing
    // point is still in the slot: B_X and B_Z are written before B_STATE is
    // cleared, exactly so this is readable from outside.
    const landed = [];
    for (let i = 0; i < prevBombs.length; i++)
      if (prevBombs[i].live && !nowBombs[i].live) landed.push(nowBombs[i]);

    // Who died, and to what. Slots that healed died and were refilled in the
    // same tick - reinforce takes the first free slot, which can be the one
    // that just emptied.
    const dead = [];
    for (let i = 0; i < UNITS; i++) {
      const a = prev[i], b = now[i];
      const refilled = (!a.alive && b.alive) || (a.alive && b.alive && b.hp > a.hp);
      if (refilled) arrived++;
      const died = (a.alive && !b.alive) || (a.alive && b.alive && b.hp > a.hp);
      if (!died) continue;
      // The position it was standing on when the bombs went off: unchanged by
      // the air phase, so the post-step one is exact unless the slot was
      // refilled underneath it.
      const at = (a.alive && b.alive) ? (ambiguous++, a) : b;
      // Was there an enemy rifle on him when he fell? Start-of-tick positions:
      // a rifleman covers 4 cm in a tick, so this is the same set the unit loop
      // saw, and it is the only handle the outside has on what killed him.
      let rifleInReach = false;
      if (!a.armour)
        for (let j = 0; j < UNITS && !rifleInReach; j++) {
          const e = prev[j];
          if (!e.alive || e.armour || e.side === a.side) continue;
          rifleInReach = Math.hypot(e.x - at.x, e.z - at.z) <= RIFLE_RANGE;
        }
      dead.push({ i, armour: a.armour, side: a.side, x: at.x, z: at.z, hpWas: a.hp, rifleInReach });
      if (a.armour) armourLost++;
    }

    for (const b of landed) {
      const blast = { t, x: b.x, z: b.z, side: b.side, where: where(b),
                      infIn: 0, armourIn: 0, inf: 0, infBull: 0, infBear: 0,
                      armour: 0, friendly: 0,
                      infInInner: 0, infInOuter: 0, infInner: 0, infOuter: 0,
                      meanIn: 0, meanKill: 0 };
      // Inside the circle when it went off. Positions do not change during the
      // air phase, so this is the same set Detonate saw.
      //
      // The distance is written down now, per man and per detonation, because
      // the head count alone cannot say whether a bomb here is worth more than
      // a bomb there for the density under it or for how far out it still
      // kills. inBands is what a bomb COVERS, killBands what it TAKES.
      let sumIn = 0;
      for (let i = 0; i < UNITS; i++) {
        const u = prev[i].alive ? now[i] : null;
        if (!u) continue;
        const d = Math.hypot(u.x - b.x, u.z - b.z);
        if (d > RADIUS) continue;
        if (u.armour) { blast.armourIn++; continue; }
        blast.infIn++;
        sumIn += d;
        inBands[bandOf(d)]++;
        if (d > RING) { blast.infInOuter++; infInOuter++; } else { blast.infInInner++; infInInner++; }
      }
      blast.meanIn = blast.infIn ? sumIn / blast.infIn : 0;
      let sumKill = 0;
      for (const d of dead) {
        const dist = Math.hypot(d.x - b.x, d.z - b.z);
        if (dist > RADIUS) continue;
        if (d.armour) {
          blast.armour++;
          if (d.claimed) doubleClaimedArmour++;
          if (d.hpWas > damageAt(dist)) sharedArmourKills++;
        } else {
          blast.inf++;
          if (d.side < 0) blast.infBull++; else blast.infBear++;
          if (d.side === b.side) blast.friendly++;
          if (d.claimed) doubleClaimedInf++; else uniqueInfClaimed++;
          if (d.hpWas > damageAt(dist)) sharedInfKills++;
          if (d.rifleInReach) claimedWithRifleInReach++;
          sumKill += dist;
          killBands[bandOf(dist)]++;
          if (dist > RING) { blast.infOuter++; infOuter++; } else { blast.infInner++; infInner++; }
        }
        d.claimed = true;
      }
      blast.meanKill = blast.inf ? sumKill / blast.inf : 0;
      if (blast.inf !== blast.infIn) blastsMismatched++;
      blasts.push(blast);
    }
    for (const d of dead) {
      if (d.claimed) continue;
      if (d.armour) shellKills++; else riflemenKilled++;
    }

    if (nowHelis.length > 0) airborneSeconds += dt;
    const inAir = nowBombs.filter((x) => x.live).length;
    if (inAir > 0) bombsInAirSeconds += dt;
    peakAirborne = Math.max(peakAirborne, nowHelis.length);
    peakBombs = Math.max(peakBombs, inAir);

    prev = now; prevHelis = nowHelis; prevBombs = nowBombs;
  }

  const exit = census(st);
  const alive = (armour, side) => exit.filter((u) => u.armour === armour && u.side === side && u.alive).length;

  const sum = (f) => blasts.reduce((a, b) => a + f(b), 0);
  const detonated = blasts.length;
  const effective = blasts.filter((b) => b.inf > 0 || b.armour > 0 || b.armourIn > 0).length;
  const offField = blasts.filter((b) => b.where === 'offfield').length;
  const ownGround = blasts.filter((b) => b.where === 'own').length;
  const infKills = sum((b) => b.inf), armourKills = sum((b) => b.armour);
  const firstKilling = blasts.find((b) => b.inf > 0 || b.armour > 0);

  const intervals = [];
  for (const side of ['-1', '1']) {
    const ts = sortieTimes[side];
    for (let i = 1; i < ts.length; i++) intervals.push(ts[i].t - ts[i - 1].t);
  }

  return {
    seed, detonated, effective, offField, ownGround,
    enemyGround: detonated - offField - ownGround,
    sorties, sortiesBull, sortiesBear, airborneSeconds, bombsInAirSeconds,
    peakAirborne, peakBombs, ambiguous, sharedArmourKills, sharedInfKills,
    doubleClaimedInf, doubleClaimedArmour, uniqueInfClaimed, claimedWithRifleInReach,
    inBands, killBands, infInInner, infInOuter, infInner, infOuter, blastsMismatched,
    infKills, armourKills, shellKills, riflemenKilled, armourLost, arrived,
    infBull: sum((b) => b.infBull), infBear: sum((b) => b.infBear),
    friendly: sum((b) => b.friendly),
    infIn: sum((b) => b.infIn), armourIn: sum((b) => b.armourIn),
    tankKillers: blasts.filter((b) => b.armour > 0).length,
    maxAbsX: Math.max(0, ...blasts.map((b) => Math.abs(b.x))),
    maxAbsZ: Math.max(0, ...blasts.map((b) => Math.abs(b.z))),
    meanAbsZ: detonated ? blasts.reduce((a, b) => a + Math.abs(b.z), 0) / detonated : 0,
    firstKillingAt: firstKilling ? firstKilling.t : null,
    biggestInf: Math.max(0, ...blasts.map((b) => b.inf)),
    biggestArmour: Math.max(0, ...blasts.map((b) => b.armour)),
    bombsBefore30: blasts.filter((b) => b.t < 30).length,
    infBefore30: blasts.filter((b) => b.t < 30).reduce((a, b) => a + b.inf, 0),
    intervals, blasts,
    exit: { bullArmour: alive(true, -1), bearArmour: alive(true, 1),
            bullInf: alive(false, -1), bearInf: alive(false, 1) },
  };
}

const rows = SEEDS.map(measure);

console.log('AIRCORE BEGIN' + (SEAM0 ? '  (seam pinned at 0, the recording\'s condition)' : '  (seam where the tape puts it)') +
            (HAS_AIR ? '' : '  [core has NO air arm - this is the control]'));

for (const r of rows) {
  console.log(`AIRCORE sorties seed=${r.seed} total=${r.sorties} bull=${r.sortiesBull} bear=${r.sortiesBear} ` +
              `onStation=${r.airborneSeconds.toFixed(1)}s share=${(r.airborneSeconds / 90).toFixed(2)} ` +
              `peakAirborne=${r.peakAirborne} bombsInAir=${r.bombsInAirSeconds.toFixed(1)}s peakBombs=${r.peakBombs} ` +
              `intervals=${r.intervals.length ? Math.min(...r.intervals).toFixed(1) + '-' + Math.max(...r.intervals).toFixed(1) : '-'}`);
  console.log(`AIRCORE bombs   seed=${r.seed} detonated=${r.detonated} ` +
              `perSortie=${r.sorties ? (r.detonated / r.sorties).toFixed(2) : '-'} ` +
              `effective=${r.effective} dud=${r.detonated - r.effective} ` +
              `offfield=${r.offField} (${r.detonated ? (r.offField / r.detonated).toFixed(2) : '-'}) ` +
              `own=${r.ownGround} enemy=${r.enemyGround} maxAbsX=${r.maxAbsX.toFixed(1)} ` +
              `meanAbsZ=${r.meanAbsZ.toFixed(1)} maxAbsZ=${r.maxAbsZ.toFixed(1)}`);
  console.log(`AIRCORE inf     seed=${r.seed} killedByBombs=${r.infKills} bull=${r.infBull} bear=${r.infBear} ` +
              `friendlyFire=${r.friendly} inRadius=${r.infIn} ` +
              `perEffective=${r.effective ? (r.infKills / r.effective).toFixed(2) : '-'} ` +
              `biggest=${r.biggestInf} byRifle=${r.riflemenKilled} ` +
              `firstKillingBombAt=${r.firstKillingAt === null ? 'never' : r.firstKillingAt.toFixed(1)} ` +
              `before30s bombs=${r.bombsBefore30} inf=${r.infBefore30}`);
  console.log(`AIRCORE armour  seed=${r.seed} inRadius=${r.armourIn} destroyedByBombs=${r.armourKills} ` +
              `bombsThatKilled=${r.tankKillers} byShell=${r.shellKills} totalLost=${r.armourLost} ` +
              `bombShare=${r.armourLost ? (r.armourKills / r.armourLost).toFixed(2) : '-'} ` +
              `arrived=${r.arrived} exit=${r.exit.bullArmour}/${r.exit.bearArmour} ` +
              `infantry=${r.exit.bullInf}/${r.exit.bearInf}`);
  if (r.ambiguous || r.sharedArmourKills)
    console.log(`AIRCORE caveat  seed=${r.seed} slotsRefilledInTheTickTheyDied=${r.ambiguous} ` +
                `tanksABombAloneCouldNotHaveKilled=${r.sharedArmourKills}`);
  // perEffectiveBomb, taken apart. The recording publishes insideRadius per
  // pass, so both factors are comparable and not only their product.
  console.log(`AIRCORE lethal  seed=${r.seed} effective=${r.effective} menInRadius=${r.infIn} ` +
              `menPerEffectiveBomb=${r.effective ? (r.infIn / r.effective).toFixed(2) : '-'} ` +
              `x lethalityInRadius=${r.infIn ? (r.infKills / r.infIn).toFixed(3) : '-'} ` +
              `= perEffectiveBomb=${r.effective ? (r.infKills / r.effective).toFixed(2) : '-'} ` +
              `blastsWhereKilledNotEqualCovered=${r.blastsMismatched}`);
  console.log(`AIRCORE ring    seed=${r.seed} ring=${RING.toFixed(2)}m ` +
              `covered inner=${r.infInInner} outer=${r.infInOuter} ` +
              `(outerShare=${r.infIn ? (r.infInOuter / r.infIn).toFixed(2) : '-'}, ` +
              `evenSpread=${(1 - (RING / RADIUS) ** 2).toFixed(2)}) ` +
              `killed inner=${r.infInner} outer=${r.infOuter} ` +
              `lethalityInner=${r.infInInner ? (r.infInner / r.infInInner).toFixed(3) : '-'} ` +
              `lethalityOuter=${r.infInOuter ? (r.infOuter / r.infInOuter).toFixed(3) : '-'} ` +
              `menABombAloneCouldNotHaveKilled=${r.sharedInfKills}`);
  console.log(`AIRCORE bands   seed=${r.seed} d/m ` +
              r.inBands.map((n, k) => `${k * BAND}-${(k + 1) * BAND}=${n}/${r.killBands[k]}` +
                                      `(${r.infIn ? (n / r.infIn).toFixed(2) : '-'}` +
                                      `|${bandArea[k].toFixed(2)})`).join(' ') +
              '   covered/killed(share|evenShare)');
  console.log(`AIRCORE claim   seed=${r.seed} claimedByBombs=${r.infKills} ` +
              `distinctMen=${r.uniqueInfClaimed} claimedTwiceInOneTick=${r.doubleClaimedInf} ` +
              `armourTwice=${r.doubleClaimedArmour} ` +
              `withAnEnemyRifleInside${RIFLE_RANGE}m=${r.claimedWithRifleInReach} ` +
              `(${r.infKills ? (r.claimedWithRifleInReach / r.infKills).toFixed(2) : '-'}) ` +
              `byRifleOutsideEveryCircle=${r.riflemenKilled}`);
  if (BOMBS) for (const b of r.blasts)
    console.log(`AIRCORE bomb seed=${r.seed} t=${b.t.toFixed(1)} side=${b.side < 0 ? 'bull' : 'bear'} ` +
                `x=${b.x.toFixed(1)} z=${b.z.toFixed(1)} where=${b.where} infIn=${b.infIn} ` +
                `armourIn=${b.armourIn} inf=${b.inf} armour=${b.armour} friendly=${b.friendly} ` +
                `coveredIn/Out=${b.infInInner}/${b.infInOuter} killedIn/Out=${b.infInner}/${b.infOuter} ` +
                `meanD=${b.meanIn.toFixed(1)} meanKillD=${b.meanKill.toFixed(1)}`);
}

// ---------------------------------------------------------------------------
// The envelope, which is the only thing the recording claims can be matched.
const span = (f) => [Math.min(...rows.map(f)), Math.max(...rows.map(f))];
const fmt = (v, d = 2) => (typeof v === 'number' ? v.toFixed(d) : String(v));

const CHECKS = [
  ['sortiesPerRound', span((r) => r.sorties), 0],
  ['sortiesPerSide', [Math.min(...rows.flatMap((r) => [r.sortiesBull, r.sortiesBear])),
                      Math.max(...rows.flatMap((r) => [r.sortiesBull, r.sortiesBear]))], 0],
  ['onStationShare', span((r) => r.airborneSeconds / 90), 2],
  ['peakAirborne', span((r) => r.peakAirborne), 0],
  ['bombsPerRound', span((r) => r.detonated), 0],
  ['bombsPerSortie', span((r) => r.detonated / r.sorties), 2],
  ['offFieldShare', span((r) => r.offField / r.detonated), 2],
  ['dudShare', span((r) => (r.detonated - r.effective) / r.detonated), 2],
  ['infantryKilledByBombs', span((r) => r.infKills), 0],
  ['infantryFriendlyFire', span((r) => r.friendly), 0],
  ['infantryPerEffectiveBomb', span((r) => r.infKills / r.effective), 2],
  ['armourDestroyedByBombs', span((r) => r.armourKills), 0],
  ['armourBombShare', span((r) => r.armourKills / r.armourLost), 2],
  ['firstKillingBombAt', span((r) => r.firstKillingAt === null ? 999 : r.firstKillingAt), 1],
  ['maxAbsLandingX', span((r) => r.maxAbsX), 1],
  ['armourLostWithAir', span((r) => r.armourLost), 0],
  ['infantryAliveWithAir', [Math.min(...rows.flatMap((r) => [r.exit.bullInf, r.exit.bearInf])),
                            Math.max(...rows.flatMap((r) => [r.exit.bullInf, r.exit.bearInf]))], 0],
];

console.log('');
console.log('AIRCORE ENVELOPE  core [lo, hi]   vs   csharp-gunships.json [lo, hi]');
let inside = 0;
for (const [name, [lo, hi], d] of CHECKS) {
  const r = ref.envelope[name];
  // Overlapping ranges, not containment: four seeds of a different army cannot
  // be expected to reproduce four seeds of the C# one exactly, and the
  // recording says as much.
  const ok = r ? !(hi < r[0] || lo > r[1]) : null;
  if (ok) inside++;
  console.log(`AIRCORE env ${name.padEnd(26)} core [${fmt(lo, d)}, ${fmt(hi, d)}]`.padEnd(70) +
              (r ? `rec [${fmt(r[0], d)}, ${fmt(r[1], d)}]  ${ok ? 'OVERLAPS' : 'OUTSIDE'}` : 'no reference'));
}
console.log(`AIRCORE ENVELOPE ${inside}/${CHECKS.length} quantities overlap the recording`);

// ---------------------------------------------------------------------------
// perEffectiveBomb, taken apart, against the recording's own passes.
//
// These two are NOT in the envelope block and are not counted in the 17. They
// are computed here from the per-pass rows the recording already publishes -
// summary.infantry.insideRadius against summary.bombs.effective - because the
// envelope quotes only their product, and the product cannot say whether the
// core's excess is more men under a bomb or more of them dying.
const airPasses = Object.entries(ref.passes)
  .filter(([, p]) => p.exit.air === 'on')
  .map(([, p]) => p.summary);
const refSpan = (f) => [Math.min(...airPasses.map(f)), Math.max(...airPasses.map(f))];
const DERIVED = [
  ['menPerEffectiveBomb', span((r) => r.infIn / r.effective),
                          refSpan((s) => s.infantry.insideRadius / s.bombs.effective), 2],
  ['lethalityInRadius', span((r) => r.infKills / r.infIn),
                        refSpan((s) => s.infantry.killedByBombs / s.infantry.insideRadius), 3],
  ['infantryPerEffectiveBomb', span((r) => r.infKills / r.effective),
                               refSpan((s) => s.infantry.perEffectiveBomb), 2],
];
console.log('');
console.log('AIRCORE DECOMPOSE  perEffectiveBomb = menPerEffectiveBomb x lethalityInRadius');
for (const [name, [lo, hi], [rlo, rhi], d] of DERIVED) {
  // A core with no air divides by zero here, and a NaN that prints OVERLAPS is
  // worse than no line at all.
  const has = Number.isFinite(lo) && Number.isFinite(hi);
  console.log(`AIRCORE dec ${name.padEnd(26)} core ${has ? `[${fmt(lo, d)}, ${fmt(hi, d)}]` : '[no bombs]'}`.padEnd(70) +
              `rec [${fmt(rlo, d)}, ${fmt(rhi, d)}]  ${!has ? 'NOT COMPARABLE' : !(hi < rlo || lo > rhi) ? 'OVERLAPS' : 'OUTSIDE'}`);
}
