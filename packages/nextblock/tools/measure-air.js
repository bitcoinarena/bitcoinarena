// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
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
// PER-DETONATION CONCENTRATION, and why the mean could not answer it.
//
// The air's excess was traced to one factor: lethality is exactly 1.000 in
// both engines, so the whole of it is MEN COVERED - the core's bombs land on
// more people, not on worse ground. `menPerEffectiveBomb` is 4.47-6.25 against
// 3.67-4.75, and that is a mean over the round. A mean cannot say which of two
// opposite things is true:
//
//   the line is uniformly denser, and every bomb finds a bit more, or
//   the line is KNOTTED, and a few bombs find a crowd while the rest find the
//   same handful the recording's do.
//
// So each detonation is now measured against its OWN counterfactual, at the
// tick it went off: the same bomb slid along x at the same z, and slid along z
// at the same x. That is the concentration - what this bomb found over what a
// bomb at a random point on that line would have found - and it separates a
// dense line from a lumpy one without a second engine.
//
// Core only, and marked so: the recording holds no distances and no positions,
// only insideRadius and a detonation count for the whole pass. What the
// recording CAN be held to is the mean, which is the DECOMPOSE block, and that
// is where the comparison stays.
//
// --core=DIR loads the core from somewhere else, which is how the no-air
// control is produced. The core has no switch for turning the air off and
// should not grow one - a rule that can be disabled at runtime is a rule two
// implementations can disagree about - so the control is the core as it was
// before the air landed:
//
//     git worktree add /tmp/noair <commit-before-the-air>
//     node tools/measure-air.js --seam0 --core=/tmp/noair/packages/nextblock/src
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
/** The seeds the recording holds, read off its own setup block. */
const REC_SEEDS = ref.setup.seeds;
/** Pooled published men and effective bombs, for the SQUAD REACH comparison. */
const REC_MEN = REC_SEEDS.reduce((a, s) => a + (ref.passes[`gunships-${s}`]?.summary.infantry.killedByBombs ?? 0), 0);
const REC_EFF = REC_SEEDS.reduce((a, s) => a + (ref.passes[`gunships-${s}`]?.summary.bombs.effective ?? 0), 0);

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
      // U_TARGET is the armour's reload counter; for a rifleman it holds his
      // squad, which is what SQUAD REACH below counts distinct values of.
      squad: st.i32[o + L.U_TARGET],
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
  const sweepPool = { x: [], z: [] };
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

    // Every rifleman standing at the top of this tick, gathered once for the
    // whole tick's detonations: the concentration sweeps below read it a
    // hundred times a bomb, and it is the same set the infIn loop counts.
    const field = [];
    if (landed.length)
      for (let i = 0; i < UNITS; i++) {
        if (!prev[i].alive || now[i].armour) continue;
        field.push({ x: now[i].x, z: now[i].z });
      }
    /**
     * The same bomb, slid along one axis, at the tick it actually went off.
     *
     * Along x it holds the blast's own z, so it asks what a bomb AT THIS DEPTH
     * would have found at a random point of the front - the x geometry
     * measure-squads already reads. Along z it holds the blast's own x and asks
     * the same question down the line's depth, which is the axis the x sweep
     * cannot see. Two-metre steps; the blast is 16 m across, so the sweep is
     * far finer than the thing it is sweeping.
     */
    const sweep = (axis, b) => {
      const counts = [];
      const at = (cx, cz) => {
        let n = 0;
        for (const u of field) if (Math.hypot(u.x - cx, u.z - cz) <= RADIUS) n++;
        return n;
      };
      if (axis === 'x') for (let x = -FRONT_X; x <= FRONT_X; x += 2) counts.push(at(x, b.z));
      else for (let z = -HALF_DEPTH; z <= HALF_DEPTH; z += 2) counts.push(at(b.x, z));
      counts.sort((p, q) => p - q);
      // Two means, and the second is the stricter control. Most of the field is
      // empty ground, so a mean over every point on the sweep is mostly
      // measuring how much of the map has nobody on it. `hit` is the mean over
      // the points that catch ANYBODY, which is the fair question: given a bomb
      // that lands on men at all, does THIS one land on more of them?
      const hits = counts.filter((v) => v > 0);
      return { counts, mean: counts.reduce((a, c) => a + c, 0) / counts.length,
               hit: hits.length ? hits.reduce((a, c) => a + c, 0) / hits.length : 0,
               med: counts[counts.length >> 1], max: counts[counts.length - 1] };
    };

    /**
     * THE GATE: how deep is each side's line at the tick a bomb goes off?
     *
     * The plank is an air-OFF observation - measure-squads reads a spread of
     * 1.0 from spawn to contact against the C#'s 0.9 growing to 6.5 - and the
     * nineteen extra men is an air-ON quantity. Nobody had measured whether the
     * core's line is still flat when its bombs actually land. If the spread has
     * already opened by the time the first killing bomb falls, the plank cannot
     * be what those bombs are finding, whatever else is.
     *
     * Living riflemen only, per side, at the top of the air phase - the same
     * set and the same tick the blast counts its covered men over, and the same
     * population measure-squads takes its z spread over (living, not armour,
     * one side), so the 1.0 plank and the recording's 6.5 are on this scale.
     *
     * TWO WIDTHS, because side-wide cannot answer it on its own. Air on, the
     * core replaces 84-118 riflemen a round from the edge, and a man walking in
     * is a living rifleman of that side at whatever depth the walk has him at.
     * Side-wide sd counts him, so the air's own churn can open the number
     * without the fighting line ever having opened - and that would rule the
     * plank out by an artefact, which is the mistake the depth pair already
     * made once. LOCAL is the same sd over that side's men within LOCAL_HALF
     * metres of the bomb in x: the piece of line the bomb is actually on. If
     * the plank survives anywhere it survives there, and a bomb 16 m across
     * cannot be finding a depth 60 m of front away.
     */
    const LOCAL_HALF = 30;
    const lineSd = () => {
      const out = {};
      for (const side of [-1, 1]) {
        const men = [];
        for (let i = 0; i < UNITS; i++) {
          const u = now[i];
          if (!prev[i].alive || u.armour || u.side !== side) continue;
          men.push(u);
        }
        const of = (g) => {
          if (g.length === 0) return { n: 0, z: 0, sd: null };
          const m = g.reduce((a, v) => a + v.z, 0) / g.length;
          return { n: g.length, z: m,
                   sd: Math.sqrt(g.reduce((a, v) => a + (v.z - m) ** 2, 0) / g.length) };
        };
        out[side] = { ...of(men), men };
      }
      return out;
    };
    const sd = landed.length ? lineSd() : null;
    /** The same sd, over one side's men within LOCAL_HALF of x. */
    const localSd = (side, x) => {
      const g = sd[side].men.filter((u) => Math.abs(u.x - x) <= LOCAL_HALF);
      if (g.length === 0) return { n: 0, sd: null };
      const m = g.reduce((a, v) => a + v.z, 0) / g.length;
      return { n: g.length,
               sd: Math.sqrt(g.reduce((a, v) => a + (v.z - m) ** 2, 0) / g.length) };
    };

    for (const b of landed) {
      const blast = { t, x: b.x, z: b.z, side: b.side, where: where(b),
                      sdBull: sd[-1].sd, sdBear: sd[1].sd,
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
      const covered = [];
      for (let i = 0; i < UNITS; i++) {
        const u = prev[i].alive ? now[i] : null;
        if (!u) continue;
        const d = Math.hypot(u.x - b.x, u.z - b.z);
        if (d > RADIUS) continue;
        if (u.armour) { blast.armourIn++; continue; }
        blast.infIn++;
        sumIn += d;
        covered.push(u);
        inBands[bandOf(d)]++;
        if (d > RING) { blast.infInOuter++; infInOuter++; } else { blast.infInInner++; infInInner++; }
      }
      blast.meanIn = blast.infIn ? sumIn / blast.infIn : 0;
      // How the men it covers are laid out under it. sdX against sdZ says
      // whether a crowded circle is a crowd across the front or a column down
      // the line's depth, which is the shape the x geometry cannot report.
      const spreadOf = (get) => {
        if (covered.length === 0) return 0;
        const m = covered.reduce((a, u) => a + get(u), 0) / covered.length;
        return Math.sqrt(covered.reduce((a, u) => a + (get(u) - m) ** 2, 0) / covered.length);
      };
      blast.sdX = spreadOf((u) => u.x);
      blast.sdZ = spreadOf((u) => u.z);
      // How many DISTINCT squads this one blast reached. See SQUAD REACH.
      blast.squads = new Set(covered.map((u) => `${u.side}:${u.squad}`)).size;
      // The line this bomb landed on: whichever side gave it the most men. A
      // bomb that found nobody has no line and is left out of the gate.
      const bull = covered.filter((u) => u.side < 0).length;
      blast.hitSide = covered.length === 0 ? 0 : (bull * 2 >= covered.length ? -1 : 1);
      blast.sdHit = blast.hitSide === 0 ? null : (blast.hitSide < 0 ? blast.sdBull : blast.sdBear);
      // The same, over the piece of line this bomb is standing on.
      const loc = blast.hitSide === 0 ? { n: 0, sd: null } : localSd(blast.hitSide, b.x);
      blast.sdHitLocal = loc.sd; blast.nHitLocal = loc.n;
      const sx = sweep('x', b), sz = sweep('z', b);
      blast.swXmean = sx.mean; blast.swXmed = sx.med; blast.swXmax = sx.max; blast.swXhit = sx.hit;
      blast.swZmean = sz.mean; blast.swZmed = sz.med; blast.swZmax = sz.max; blast.swZhit = sz.hit;
      // Pooled, so the sweep can supply the NULL for the bombs' own spread of
      // counts: a lumpy line makes a lumpy sweep too, and a top-quartile share
      // means nothing without the share the same line gives a bomb thrown
      // anywhere. Only x-sweeps at a depth a bomb actually reached are pooled.
      if (b.where !== 'offfield') { sweepPool.x.push(...sx.counts); sweepPool.z.push(...sz.counts); }
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

  // ---------------------------------------------------------------------
  // Per-detonation concentration. Core only.
  const onMen = blasts.filter((b) => b.infIn > 0);
  const share = (xs) => {
    if (xs.length === 0) return 0;
    const c = [...xs].sort((a, b) => a - b);
    const tot = c.reduce((a, v) => a + v, 0);
    return tot ? c.slice(Math.ceil(c.length * 0.75)).reduce((a, v) => a + v, 0) / tot : 0;
  };
  const counts = onMen.map((b) => b.infIn).sort((a, b) => a - b);
  const at = (f) => (counts.length ? counts[Math.min(counts.length - 1, Math.floor(f * counts.length))] : 0);
  const agg = (f) => onMen.reduce((a, b) => a + f(b), 0);
  const n = onMen.length || 1;
  const totIn = counts.reduce((a, v) => a + v, 0);
  // The ratio is of the TOTALS, not the mean of the per-bomb ratios: a bomb
  // whose sweep mean is a fraction of a man would otherwise carry the whole
  // number on its own.
  const conc = {
    onMen: onMen.length, med: at(0.5), p90: at(0.9), max: counts.length ? counts[counts.length - 1] : 0,
    // The null is taken over the sweep points that catch anybody, for the same
    // reason `hit` exists: empty ground is not a small bomb, it is no bomb, and
    // pooling it makes any set of real detonations look evenly spread.
    topQ: share(counts), topQnullX: share(sweepPool.x.filter((v) => v > 0)),
    topQnullZ: share(sweepPool.z.filter((v) => v > 0)),
    concX: agg((b) => b.swXmean) ? totIn / agg((b) => b.swXmean) : 0,
    concZ: agg((b) => b.swZmean) ? totIn / agg((b) => b.swZmean) : 0,
    concXhit: agg((b) => b.swXhit) ? totIn / agg((b) => b.swXhit) : 0,
    concZhit: agg((b) => b.swZhit) ? totIn / agg((b) => b.swZhit) : 0,
    swX: agg((b) => b.swXmean) / n, swZ: agg((b) => b.swZmean) / n,
    swXhit: agg((b) => b.swXhit) / n, swZhit: agg((b) => b.swZhit) / n,
    sdX: agg((b) => b.sdX) / n, sdZ: agg((b) => b.sdZ) / n,
  };

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
    stillFlying: prevBombs.filter((x) => x.live).length,
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
    intervals, blasts, conc,
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
  const k = r.conc;
  console.log(`AIRCORE conc    seed=${r.seed} bombsOnMen=${k.onMen} menPerBomb med=${k.med} p90=${k.p90} max=${k.max} ` +
              `topQuartileShare=${k.topQ.toFixed(2)} (sweep null x=${k.topQnullX.toFixed(2)} z=${k.topQnullZ.toFixed(2)})`);
  console.log(`AIRCORE conc    seed=${r.seed} sameBombAtARandom x=${k.swX.toFixed(2)} z=${k.swZ.toFixed(2)} men ` +
              `-> concentrationX=${k.concX.toFixed(2)} concentrationZ=${k.concZ.toFixed(2)}`);
  console.log(`AIRCORE conc    seed=${r.seed} ..that catches anybody x=${k.swXhit.toFixed(2)} z=${k.swZhit.toFixed(2)} men ` +
              `-> concentrationX=${k.concXhit.toFixed(2)} concentrationZ=${k.concZhit.toFixed(2)}   ` +
              `coveredMen sdX=${k.sdX.toFixed(1)} sdZ=${k.sdZ.toFixed(1)}`);
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
                `meanD=${b.meanIn.toFixed(1)} meanKillD=${b.meanKill.toFixed(1)} ` +
                `sweepX=${b.swXmean.toFixed(2)} sweepZ=${b.swZmean.toFixed(2)} ` +
                `sdX=${b.sdX.toFixed(1)} sdZ=${b.sdZ.toFixed(1)}`);
}

// ---------------------------------------------------------------------------
// THE GATE: is the line still a plank when the bombs land?  Core only.
//
// The one named, measured rule difference the last pass turned up is that
// RIFLE_WALK is a single constant where Army.Populate draws pace per man, so
// the core's line arrives at contact as flat as it spawned (spread 1.0 against
// the C#'s 0.9 growing to 6.5). It is a candidate for the nineteen extra men
// the core's bombs cover - and it was measured AIR OFF, while the nineteen men
// are an air-ON quantity. This asks the question in the condition it belongs
// to: at the tick each detonation goes off, how deep is the line it lands on?
//
// If the spread has already opened before the bombs that do the killing fall,
// the plank cannot be what they are finding, and (l)'s last term needs a
// different candidate.
const GATE_BANDS = [[0, 2], [2, 4], [4, 8], [8, Infinity]];
/**
 * One seed's detonations that caught infantry, banded by the depth of the line
 * they landed on. `pick` chooses the width the banding is done at - side-wide
 * or local - so the same arithmetic is run twice and the two are read against
 * each other rather than one of them being taken on trust.
 */
const gateOf = (r, pick = (b) => b.sdHit) => {
  const on = r.blasts.filter((b) => b.infIn > 0 && pick(b) !== null);
  const bands = GATE_BANDS.map(([lo, hi]) => {
    const g = on.filter((b) => pick(b) >= lo && pick(b) < hi);
    return { bombs: g.length, men: g.reduce((a, b) => a + b.infIn, 0) };
  });
  const men = on.reduce((a, b) => a + b.infIn, 0);
  const flat = on.filter((b) => pick(b) < 3).reduce((a, b) => a + b.infIn, 0);
  const first = r.blasts.find((b) => b.inf > 0);
  return { on, bands, men, flat, first,
           wsd: men ? on.reduce((a, b) => a + pick(b) * b.infIn, 0) / men : 0 };
};

console.log('');
console.log('AIRCORE ' + '='.repeat(70));
console.log('AIRCORE SQUAD REACH  how many squads one blast reaches. A DESCRIPTION, not a cause.');
console.log('AIRCORE   CORE ONLY: the recording publishes no per-squad geometry, so nothing');
console.log('AIRCORE   here is a pair. It says what the core does; it does not say the C# does');
console.log('AIRCORE   otherwise, and no reading of it may be quoted as a difference.');
console.log('AIRCORE');
console.log('AIRCORE   This block once carried the claim that the core has no squad depth. That');
console.log('AIRCORE   is RETRACTED and wrong. army.js:137 and 142-143 already implement');
console.log('AIRCORE   Army.cs:652\'s goalZ = front - Dir * (standoff + squadOffsetZ): RIFLE_SQUAD_Z');
console.log('AIRCORE   gives each man -4.84..4.99 m, sd 2.851 against the C# draw Rand(-5,5)\'s');
console.log('AIRCORE   2.887, over 69 distinct values in 72 slots. The 16.8 m that looked like a');
console.log('AIRCORE   difference was a whole SIDE including the men still walking in from');
console.log('AIRCORE   |z| = 79; in contact the core is 3.90-4.72 m against the 3.85 its own rule');
console.log('AIRCORE   intends. The squad x-spread matches too, 5.0 m against the rule\'s 5.196.');
if (HAS_AIR) {
  const reach = rows.flatMap((r) => r.blasts.filter((b) => b.infIn > 0));
  const byN = new Map();
  for (const b of reach) {
    const e = byN.get(b.squads) || { bombs: 0, men: 0 };
    e.bombs++; e.men += b.infIn; byN.set(b.squads, e);
  }
  const menAll = reach.reduce((a, b) => a + b.infIn, 0);
  for (const r of rows) {
    const on = r.blasts.filter((b) => b.infIn > 0);
    const one = on.filter((b) => b.squads === 1), many = on.filter((b) => b.squads > 1);
    const sum = (g) => g.reduce((a, b) => a + b.infIn, 0);
    console.log(`AIRCORE reach seed=${r.seed} bombsOnMen=${on.length} ` +
                `oneSquad=${one.length}b/${sum(one)}m ` +
                `severalSquads=${many.length}b/${sum(many)}m ` +
                `maxSquads=${Math.max(...on.map((b) => b.squads))}`);
  }
  console.log('AIRCORE');
  console.log('AIRCORE   squads reached   bombs   men   men/bomb   share of covered men');
  for (const k of [...byN.keys()].sort((a, b) => a - b)) {
    const e = byN.get(k);
    console.log(`AIRCORE   ${String(k).padStart(14)}  ${String(e.bombs).padStart(6)}  ${String(e.men).padStart(4)}  ` +
                `${(e.men / e.bombs).toFixed(2).padStart(8)}   ${(e.men / menAll).toFixed(2)}`);
  }
  // The counterfactual, built from the core's OWN single-squad mean so that
  // nothing is imported from the other engine. It is deliberately STRICTER
  // than the C# rule - two C# squads sitting within 16 m can share a bomb too -
  // so it is an upper bound on what interpenetration is worth, not an estimate.
  const one = reach.filter((b) => b.squads === 1), many = reach.filter((b) => b.squads > 1);
  const oneMen = one.reduce((a, b) => a + b.infIn, 0);
  const base = one.length ? oneMen / one.length : 0;
  const eff = rows.reduce((a, r) => a + r.effective, 0);
  const cf = (oneMen + many.length * base) / eff;
  console.log('AIRCORE');
  console.log(`AIRCORE   men a round        core ${(menAll / rows.length).toFixed(1)}   ` +
              `capped at one squad ${((oneMen + many.length * base) / rows.length).toFixed(1)}`);
  console.log(`AIRCORE   perEffectiveBomb   core ${(menAll / eff).toFixed(2)}   capped ${cf.toFixed(2)}` +
              `   recording ${(REC_MEN / REC_EFF).toFixed(2)}`);
  console.log(`AIRCORE   the excess this item is about is ${((menAll - REC_MEN) / rows.length).toFixed(1)} men a round;` +
              ` the cap removes ${((menAll - oneMen - many.length * base) / rows.length).toFixed(1)},`);
  console.log('AIRCORE   which OVERSHOOTS it - so interpenetration is more than sufficient to');
  console.log('AIRCORE   carry the whole term, and the cap is an upper bound, not an estimate.');
} else {
  console.log('AIRCORE reach  no air arm in this core - nothing to reach with');
}
console.log('AIRCORE ' + '='.repeat(70));

console.log('');
console.log('AIRCORE ' + '='.repeat(70));
console.log('AIRCORE GATE  the depth of the line each bomb lands on, at its own tick');
console.log('AIRCORE   core only: the recording holds no positions. sd is of the covered');
console.log('AIRCORE   side\'s living riflemen in z - measure-squads\' own population, so the');
console.log('AIRCORE   plank\'s 1.0 and the C# line\'s 6.5 m are on this scale.');
console.log('AIRCORE   TWO WIDTHS: side-wide counts the 84-118 men a round walking in as');
console.log('AIRCORE   replacements, which the air itself creates; LOCAL is the same sd over');
console.log('AIRCORE   that side\'s men within 30 m of the bomb in x, which is the piece of');
console.log('AIRCORE   line a 16 m blast is actually standing on. LOCAL is the one that');
console.log('AIRCORE   answers the plank; side-wide is printed beside it to show the gap.');
if (HAS_AIR) {
  for (const r of rows) {
    for (const [tag, pick] of [['wide ', (b) => b.sdHit], ['local', (b) => b.sdHitLocal]]) {
      const g = gateOf(r, pick);
      const f = g.first;
      console.log(`AIRCORE gate ${tag} seed=${r.seed} bombsOnMen=${g.on.length} coveredMen=${g.men} ` +
                  `firstInfantryKillingBombAt=${f ? f.t.toFixed(1) : 'never'} ` +
                  `lineSdThere=${f && pick(f) !== null ? pick(f).toFixed(1) : '-'} ` +
                  `meanLineSd(weighted by men)=${g.wsd.toFixed(1)} ` +
                  `menTakenWhileSd<3=${g.flat} (${g.men ? (g.flat / g.men).toFixed(2) : '-'})`);
      console.log(`AIRCORE gate ${tag} seed=${r.seed} ` +
                  GATE_BANDS.map(([lo, hi], k) => `sd ${lo}-${hi === Infinity ? '+' : hi}: ` +
                    `${g.bands[k].bombs}b/${g.bands[k].men}m` +
                    `(${g.bands[k].bombs ? (g.bands[k].men / g.bands[k].bombs).toFixed(1) : '-'})`).join('  ') +
                  '   bombs/men(menPerBomb)');
    }
  }
  // Pooled, because four seeds of ten bombs each is a thin band on its own.
  for (const [tag, pick] of [['wide ', (b) => b.sdHit], ['local', (b) => b.sdHitLocal]]) {
    const all = rows.flatMap((r) => gateOf(r, pick).on);
    const men = all.reduce((a, b) => a + b.infIn, 0);
    console.log(`AIRCORE gate POOLED ${tag} ` +
                GATE_BANDS.map(([lo, hi]) => {
                  const g = all.filter((b) => pick(b) >= lo && pick(b) < hi);
                  const m = g.reduce((a, b) => a + b.infIn, 0);
                  return `sd ${lo}-${hi === Infinity ? '+' : hi}: ${g.length}b/${m}m` +
                         `(${g.length ? (m / g.length).toFixed(1) : '-'}, ${men ? (m / men).toFixed(2) : '-'} of the men)`;
                }).join('  '));
  }
  // How many men the local window holds, so a small sd cannot be a small sample
  // wearing a line's name.
  const loc = rows.flatMap((r) => r.blasts.filter((b) => b.infIn > 0 && b.sdHitLocal !== null));
  const ns = loc.map((b) => b.nHitLocal).sort((a, b) => a - b);
  console.log(`AIRCORE gate the local window holds n = ${ns[0]}-${ns[ns.length - 1]} men ` +
              `(median ${ns[ns.length >> 1]}) of the covered side, over ${ns.length} bombs`);
  // What the recording can say about WHEN: its air series carries cumulative
  // bombKills at five seconds, so the sample its first bomb death lands in is
  // read off the file rather than remembered in the tool.
  const firstRec = REC_SEEDS.map((seed) => {
    const a = ref.passes[`gunships-${seed}`]?.air;
    const row = a && a.find((x) => x.bombKills > 0);
    return row ? row.t : null;
  });
  // Both sides infantry: the recording's `bombKills` counts men, armour is its
  // own column, and r.firstKillingAt is the first bomb to kill ANYTHING.
  console.log(`AIRCORE gate the recording's first bomb DEATH lands in the sample ending at ` +
              `[${firstRec.join(', ')}] s; the core's first infantry-killing bomb is at ` +
              `[${rows.map((r) => { const f = gateOf(r).first; return f ? f.t.toFixed(1) : 'never'; }).join(', ')}]` +
              ' (a sample end against an exact tick, so the pair is coarse on the left)');
} else {
  console.log('AIRCORE gate  no air arm in this core - nothing to gate');
}
console.log('AIRCORE ' + '='.repeat(70));

// ---------------------------------------------------------------------------
// THE BOMB TOLL, PER FIVE SECONDS, CROSS-ENGINE.
//
// csharp-gunships.json carries an `air` array per pass - eighteen samples at
// five seconds, with cumulative detonations, bomb deaths, armour killed and
// armour lost - and this tool has only ever read `summary`. It is the one
// cross-engine time series the air has.
//
// What it can and cannot be: `insideRadius` and the dud/effective split are
// pass totals, so menPerEffectiveBomb itself cannot be sliced. What pairs per
// window is kills per DETONATION - all detonations, duds included - and
// because lethalityInRadius is 1.000 in both engines that is men per bomb with
// the lethality divided out. It is NOT the published 4.47-6.25 against
// 3.67-4.75 pair, whose denominator is the effective bombs only, and it is not
// to be quoted as it.
const airSeries = (seed) => ref.passes[`gunships-${seed}`]?.air ?? null;
const WIN = 5;

console.log('');
console.log('AIRCORE ' + '='.repeat(70));
console.log('AIRCORE WINDOW  bomb deaths per detonation, five-second windows, air on');
console.log('AIRCORE   denominator is ALL detonations - duds included - not the effective');
console.log('AIRCORE   ones. Not the menPerEffectiveBomb pair. Lethality is 1.000 in both');
console.log("AIRCORE   engines, so this is men per detonation with the lethality divided out.");
if (!HAS_AIR || !SEAM0) {
  console.log(`AIRCORE   WITHHELD: ${HAS_AIR ? 'this run is not seam pinned' : 'this core has no air arm'}` +
              ' - the recording is seam z=0 with the air on, and that is not a pair.');
} else {
  const totals = [];
  for (const r of rows) {
    const rec = airSeries(r.seed);
    console.log('AIRCORE');
    console.log(`AIRCORE window seed=${r.seed}` + (rec ? '' : '   (the recording holds no gunships pass for this seed)'));
    console.log('AIRCORE   t     core bombs kills perBomb  |  REC bombs kills perBomb');
    const core = [];
    for (let t = WIN; t <= 90; t += WIN) {
      const inWin = r.blasts.filter((b) => b.t > t - WIN && b.t <= t);
      core.push({ t, bombs: inWin.length, kills: inWin.reduce((a, b) => a + b.inf, 0) });
    }
    const recWin = [];
    if (rec) {
      let pb = 0, pk = 0;
      for (const row of rec) { recWin.push({ t: row.t, bombs: row.bombs - pb, kills: row.bombKills - pk });
                               pb = row.bombs; pk = row.bombKills; }
    }
    const cell = (w) => w
      ? `${String(w.bombs).padStart(5)} ${String(w.kills).padStart(5)}  ` +
        `${(w.bombs ? (w.kills / w.bombs).toFixed(2) : '-').padStart(7)}`
      : '    -     -        -';
    for (let i = 0; i < core.length; i++)
      console.log(`AIRCORE   ${String(core[i].t).padStart(2)}   ${cell(core[i])}  | ${cell(recWin[i])}`);
    const sum = (ws, from = 0) => ws.slice(from).reduce((a, w) => ({ bombs: a.bombs + w.bombs, kills: a.kills + w.kills }),
                                                        { bombs: 0, kills: 0 });
    // Self-anchored as well as absolute: the sortie clock is on
    // UnityEngine.Random in the C# and on the army stream in the core, so the
    // two rounds are not in phase. From each engine's own first killing window
    // onward, they are both measured from the moment their air started to bite.
    const firstOf = (ws) => Math.max(0, ws.findIndex((w) => w.kills > 0));
    const ca = sum(core), cf = sum(core, firstOf(core));
    const ra = rec ? sum(recWin) : null, rf = rec ? sum(recWin, firstOf(recWin)) : null;
    const say = (name, x) => x && console.log(
      `AIRCORE   ${name.padEnd(22)} bombs=${String(x.bombs).padStart(3)} kills=${String(x.kills).padStart(3)} ` +
      `perDetonation=${x.bombs ? (x.kills / x.bombs).toFixed(2) : '-'}`);
    say('core whole round', ca); say('REC whole round', ra);
    say('core from its first', cf); say('REC from its first', rf);
    if (ra) totals.push({ seed: r.seed, ca, cf, ra, rf,
                         cw: { win: core.slice(firstOf(core)) },
                         rw: { win: recWin.slice(firstOf(recWin)) } });
  }

  if (totals.length) {
    const per = (x) => x.kills / x.bombs;
    const span = (f) => `${Math.min(...totals.map(f)).toFixed(2)}-${Math.max(...totals.map(f)).toFixed(2)}`;
    const pool = (pick) => totals.reduce((a, s) => a + pick(s).kills, 0) /
                           totals.reduce((a, s) => a + pick(s).bombs, 0);
    console.log('AIRCORE');
    console.log(`AIRCORE BOMB DEATHS PER DETONATION, ${totals.length} seeds, air on, seam pinned`);
    console.log('AIRCORE ' + ' '.repeat(28) + 'per seed'.padEnd(16) + 'pooled');
    const row = (name, pick) => console.log('AIRCORE ' + name.padEnd(28) +
      span((s) => per(pick(s))).padEnd(16) + pool(pick).toFixed(2));
    row('core, whole round', (s) => s.ca);
    row('C# recording, whole round', (s) => s.ra);
    row('core, from its first kill', (s) => s.cf);
    row('C# from its first kill', (s) => s.rf);
    // Early against late, anchored on each engine's own first killing window,
    // pooled because ten bombs a seed cannot carry a trend. If the excess is
    // only in the first windows it is the approach - the line arriving as a
    // plank and being caught before it opens; if it is flat across the round
    // it is the standing line, and the approach cannot be the cause.
    console.log('AIRCORE');
    console.log(`AIRCORE   the same, split at three windows past each engine's first killing`);
    console.log('AIRCORE   window (w0-w2 is the first fifteen seconds of ITS air war)');
    const half = (pick, from, to) => {
      let bombs = 0, kills = 0;
      for (const s of totals) {
        const w = pick(s).win.slice(from, to);
        bombs += w.reduce((a, v) => a + v.bombs, 0);
        kills += w.reduce((a, v) => a + v.kills, 0);
      }
      return { bombs, kills };
    };
    const hrow = (name, pick) => {
      const e = half(pick, 0, 3), l = half(pick, 3, Infinity);
      console.log('AIRCORE   ' + name.padEnd(26) +
        `w0-w2 ${(e.bombs ? (e.kills / e.bombs).toFixed(2) : '-').padStart(5)} (${e.kills}/${e.bombs})`.padEnd(24) +
        `w3+ ${(l.bombs ? (l.kills / l.bombs).toFixed(2) : '-').padStart(5)} (${l.kills}/${l.bombs})`);
    };
    hrow('core', (s) => s.cw);
    hrow('C# recording', (s) => s.rw);
    console.log('AIRCORE   the counts themselves: core bombs [' + totals.map((s) => s.ca.bombs) +
                '] kills [' + totals.map((s) => s.ca.kills) + ']');
    console.log('AIRCORE                          REC  bombs [' + totals.map((s) => s.ra.bombs) +
                '] kills [' + totals.map((s) => s.ra.kills) + ']');
  }
}
console.log('AIRCORE ' + '='.repeat(70));

// ---------------------------------------------------------------------------
// The envelope, which is the only thing the recording claims can be matched.
const span = (f) => [Math.min(...rows.map(f)), Math.max(...rows.map(f))];
const fmt = (v, d = 2) => (typeof v === 'number' ? v.toFixed(d) : String(v));

// The recording's air-on passes, read per pass. `ref.envelope` carries only
// seventeen of the quantities the file publishes; everything else has to be
// spanned from the passes themselves, which is what `refSpan` is for. Declared
// here rather than beside DECOMPOSE because CHECKS now uses it.
const airPasses = Object.entries(ref.passes)
  .filter(([, p]) => p.exit.air === 'on')
  .map(([, p]) => p.summary);
const refSpan = (f) => [Math.min(...airPasses.map(f)), Math.max(...airPasses.map(f))];
const bothSides = (f, g) => [Math.min(...airPasses.flatMap((s) => [f(s), g(s)])),
                             Math.max(...airPasses.flatMap((s) => [f(s), g(s)]))];

// Each row is [name, core span, decimals, published span].
// The fourth element is present when the quantity has no `ref.envelope` entry
// and must be spanned off the passes. EVERY column on the right is a field the
// recording publishes - none is derived for the comparison.
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

  // Published from the first pass and never once compared. They were found by
  // enumerating the file rather than by remembering it, which is how
  // armour.insideRadius - the discriminator that localised (l)'s last term -
  // turned up after sitting unused all along.
  ['infantryInsideRadius', span((r) => r.infIn), 0, refSpan((s) => s.infantry.insideRadius)],
  ['armourInsideRadius', span((r) => r.armourIn), 0, refSpan((s) => s.armour.insideRadius)],
  ['bombsThatKilledArmour', span((r) => r.tankKillers), 0,
                            refSpan((s) => s.armour.bombsThatKilledArmour)],
  ['armourDestroyedByShell', span((r) => r.shellKills), 0,
                             refSpan((s) => s.armour.destroyedByShell)],
  ['infantryKilledByRifle', span((r) => r.riflemenKilled), 0,
                            refSpan((s) => s.infantry.killedByRifle)],
  ['bombsOwnGround', span((r) => r.ownGround), 0, refSpan((s) => s.bombs.ownGround)],
  ['bombsEnemyGround', span((r) => r.enemyGround), 0, refSpan((s) => s.bombs.enemyGround)],
  ['bombsStillFlyingAtEnd', span((r) => r.stillFlying), 0,
                            refSpan((s) => s.bombs.stillFlyingAtEnd)],
  ['bombsInAirSeconds', span((r) => r.bombsInAirSeconds), 1,
                        refSpan((s) => s.sorties.bombsInAirSeconds)],
  ['infantryKilledByBombsPerSide',
   [Math.min(...rows.flatMap((r) => [r.infBull, r.infBear])),
    Math.max(...rows.flatMap((r) => [r.infBull, r.infBear]))], 0,
   bothSides((s) => s.infantry.bull, (s) => s.infantry.bear)],
  ['doubleFireInfantry', span((r) => r.doubleClaimedInf), 0,
                         refSpan((s) => s.doubleFire.infantry)],
  ['doubleFireArmour', span((r) => r.doubleClaimedArmour), 0,
                       refSpan((s) => s.doubleFire.armour)],
];

// NOT a check, and the reason is worth keeping where the next reader will find
// it. `summary.doubleFire.ambiguousBombMatch` is published and unused, and it
// looks like a pair for this file's `ambiguous`. It is not. The recording
// counts detonations it could not attribute to exactly ONE bomb, by comparing
// positions (`GunshipReferenceTests.cs:120`, `b.x == p.x && b.z == p.y`) - a
// property of floating point and of how a recorder identifies a bomb. This
// file's `ambiguous` counts SLOTS REFILLED IN THE TICK THEY DIED (line 248),
// which it prints under that name. Two unrelated quantities sharing a word.
// Paired once during this pass, it read core [2, 3] against rec [0, 0] and
// showed as the one OUTSIDE in thirty - a not-a-pair caught by the check
// rather than by argument. The core has no counterpart at all: it identifies a
// bomb by its slot, never by matching a position.
console.log('');
console.log('AIRCORE NOT COMPARED  doubleFire.ambiguousBombMatch is published and left out:');
console.log('AIRCORE   the recording counts blasts it could not tie to one bomb by position;');
console.log('AIRCORE   this file\'s `ambiguous` counts slots refilled in the tick they died.');
console.log('AIRCORE   Same word, unrelated quantities. The core has no counterpart - it');
console.log('AIRCORE   identifies a bomb by slot, never by matching a position.');

console.log('');
console.log('AIRCORE ENVELOPE  core [lo, hi]   vs   csharp-gunships.json [lo, hi]');
let inside = 0;
for (const [name, [lo, hi], d, published] of CHECKS) {
  const r = published ?? ref.envelope[name];
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
const DERIVED = [
  ['menPerEffectiveBomb', span((r) => r.infIn / r.effective),
                          refSpan((s) => s.infantry.insideRadius / s.bombs.effective), 2],
  ['lethalityInRadius', span((r) => r.infKills / r.infIn),
                        refSpan((s) => s.infantry.killedByBombs / s.infantry.insideRadius), 3],
  ['infantryPerEffectiveBomb', span((r) => r.infKills / r.effective),
                               refSpan((s) => s.infantry.perEffectiveBomb), 2],
];
// ---------------------------------------------------------------------------
// THE SAME QUESTION ASKED OF THE TANKS.
//
// `summary.armour.insideRadius` and `summary.armour.bombsThatKilledArmour` have
// been in the recording from the first pass and no check has ever used them.
// They are the 19 men asked of a different population standing on the same
// ground at the same moment: if the core's bombs cover the recording's number
// of TANKS but more MEN, then the ground the bombs find is not busier and the
// difference is in how the INFANTRY are arranged. Computed from the per-pass
// rows, like DECOMPOSE, not from the envelope block.
console.log('');
console.log('AIRCORE TANKS  the same ground, a different population');
console.log('AIRCORE   The three envelope rows this reads - infantryInsideRadius,');
console.log('AIRCORE   armourInsideRadius, bombsThatKilledArmour - are checked above. What is');
console.log('AIRCORE   here is the ratio, which is the whole point: same bombs, same ground.');
{
  const ci = rows.reduce((a, r) => a + r.infIn, 0), ca = rows.reduce((a, r) => a + r.armourIn, 0);
  const ri = airPasses.reduce((a, s) => a + s.infantry.insideRadius, 0);
  const ra = airPasses.reduce((a, s) => a + s.armour.insideRadius, 0);
  console.log(`AIRCORE also pooled: infantry covered ${ci} against ${ri} = ${(ci / ri).toFixed(2)}x,` +
              ` armour covered ${ca} against ${ra} = ${(ca / ra).toFixed(2)}x`);
}

console.log('');
console.log('AIRCORE DECOMPOSE  perEffectiveBomb = menPerEffectiveBomb x lethalityInRadius');
for (const [name, [lo, hi], [rlo, rhi], d] of DERIVED) {
  // A core with no air divides by zero here, and a NaN that prints OVERLAPS is
  // worse than no line at all.
  const has = Number.isFinite(lo) && Number.isFinite(hi);
  console.log(`AIRCORE dec ${name.padEnd(26)} core ${has ? `[${fmt(lo, d)}, ${fmt(hi, d)}]` : '[no bombs]'}`.padEnd(70) +
              `rec [${fmt(rlo, d)}, ${fmt(rhi, d)}]  ${!has ? 'NOT COMPARABLE' : !(hi < rlo || lo > rhi) ? 'OVERLAPS' : 'OUTSIDE'}`);
}
