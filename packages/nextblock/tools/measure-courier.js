// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// The truck under fire, laid beside csharp-infantry.json's `courier` pass.
//
// That pass parks a truck at x=0, z=0 and leaves it there for ninety seconds,
// taking whatever the army gives it, and publishes eighteen samples of
//
//     t, rifleHits, rifleDmg, tankHits, tankDmg, totalDmg, inRifle, inTank
//
// It splits rifle from tank BY THE SIZE OF THE HIT, and says so: CourierHit
// carries only an amount, and with Heat at zero the two bands are disjoint -
// a rifle takes 1.5-3.5, a tank 5-11. That is a property of the recorder, not
// of the rule, and it is quoted here as such.
//
//     node tools/measure-courier.js [seed ...] [--seam0]
//
// WHERE THE TRUCK STANDS IS THE PAIR. The recording parks it at (0, 0), in the
// middle of the seam. Every other tool in this directory leaves it at START,
// (-100.4, 10.2) on the apron - and that is 12.4 m from the army's western
// edge, which is why the `idle` vector takes damage at all. Measuring here
// with the truck at START would be the sixth not-a-pair in this item. It is
// placed with `teleport`, the core's own respawn API: it writes position words
// and clears the momentum, and it draws NOTHING from the stream.
//
// WHAT CAN AND CANNOT BE PAIRED. `inRifle` and `inTank` are exact pairs at
// every sample. The rifle/tank SPLIT is readable since (j): a tank writes
// Rand(5, 11) and a rifleman Rand(1.5, 3.5), the two bands do not meet at Heat
// zero, and this file tells them apart by size the way the recorder does.
// Before (j) it could not - every core hit was one flat point - and that was
// one of the four faults (j) existed to fix.
//
// `totalDmg` stops being a pair once the tanks do real work. The core's truck
// holds 100 points and T_HP floors at zero, so it dies partway through and the
// column goes blind, where the recorder accumulates past 100 because its
// courier is a position and not a vehicle. Shots and hits do not saturate and
// are what the acceptance is read from.
//
// Prints; asserts nothing.

import { readFileSync } from 'node:fs';
import { init, step, teleport, UNITS } from '../src/sim.js';
import * as L from '../src/state.js';
import { pickTarget, pickRifleTarget, RELOAD_MIN, RELOAD_SPAN, ARMOUR_RANGE,
         COURIER_RANGE as CR_FX, RIFLE_RANGE as RR_FX } from '../src/rules/army.js';
import { length2, sub, abs } from '../src/fixed.js';

// The recording's courier pass is `air: "none"`, so this run must be too, or
// it is not a pair - the same fault the depth pair was made of. The air is
// held down from OUTSIDE the rules, exactly as measure-infantry.js does it:
// the sortie clocks are pinned high so `launchSorties` returns without
// drawing, and any live gunship or bomb is cleared. No rule is called and
// nothing but the air's own state words is written.
const CLOCK_HIGH = 1 << 30;
const HAS_AIR = typeof L.O_HELIS === 'number';
function holdAir(st) {
  if (!HAS_AIR) return st;
  const s = st.i32;
  s[L.O_AIR + L.AIR_BULL] = CLOCK_HIGH;
  s[L.O_AIR + L.AIR_BEAR] = CLOCK_HIGH;
  for (let i = 0; i < L.MAX_HELIS; i++) s[L.heliBase(i) + L.H_STATE] = 0;
  for (let i = 0; i < L.MAX_BOMBS; i++) s[L.bombBase(i) + L.B_STATE] = 0;
  return st;
}

const args = process.argv.slice(2);
const SEAM0 = args.includes('--seam0');
const SEEDS = args.filter((a) => !a.startsWith('--')).map(Number);

const ref = JSON.parse(readFileSync(new URL('../test/vectors/csharp-infantry.json', import.meta.url), 'utf8'));
const PASS = ref.passes.courier;
const REC = PASS.rows;
const [CX, CZ] = PASS.courier;
const COURIER_RANGE = ref.setup.courierRange;      // 34, read off the file
const RIFLE_R = ref.setup.rifleRange;              // 26
if (SEEDS.length === 0) SEEDS.push(ref.setup.seed);

const Q = 65536, q = (v) => v / Q, fx = (m) => Math.round(m * Q);
// The two clocks a courier shot writes, so the 23 points can be split without
// touching a rule. A tank's courier fire lives in army.js and writes
// U_COOLDOWN in the 40-99 band; nothing else writes an armour cooldown, the
// gun's own reload being in U_TARGET. A rifleman has ONE clock and takes the
// truck branch FIRST whenever the truck is inside 26 m (sim.js:722), so a
// reload-band write by a man that close is a shot at the truck and not at a
// foe. The bands do not meet.
const TANK_CLOCK = [40, 99], RIFLE_CLOCK = [150, 269];
// The tank's GUN reload, which is the clock the courier will have to share
// once (j) puts the target choice inside it. It lives in U_TARGET, not
// U_COOLDOWN - the armour's private courier weapon is the one in U_COOLDOWN.
const GUN_CLOCK = [RELOAD_MIN, RELOAD_MIN + RELOAD_SPAN - 1];
const isArmour = (i) => (i & 3) === 0;
const T = L.O_TRUCK;

console.log(`COURIER  truck parked at (${CX}, ${CZ}) for ${ref.setup.durationSeconds} s, ` +
            `the recording's own courier position`);
console.log(`COURIER  recording: seed ${ref.setup.seed}, ${ref.setup.seam}, air ${ref.setup.air}, ` +
            `heat ${ref.setup.heat}, flow ${ref.setup.flow}`);
console.log('COURIER  the core is run AIR OFF to match, by pinning the sortie clocks from');
console.log('COURIER  outside the rules - the recording\'s pass is air "none".');
console.log(`COURIER  courierRange ${COURIER_RANGE} m, rifleRange ${RIFLE_R} m - both read off the file`);
console.log('COURIER  rifle and tank are told apart BY THE SIZE of the hit, the way the');
console.log('COURIER  recorder does it: a tank takes Rand(5,11), a rifleman Rand(1.5,3.5), and');
console.log('COURIER  the bands do not meet at heat 0. Before (j) every core hit was one flat');
console.log('COURIER  point and no split was possible.');

function measure(seed) {
  const st = init(seed);
  if (SEAM0) st.tape.fill(st.tape[0]);
  holdAir(st);
  teleport(st, fx(CX), fx(CZ), 0);
  const hp0 = st.i32[T + L.T_HP];
  const rows = [];
  const SAMPLE = 5 * 60;
  const cool = () => {
    const o = [];
    for (let i = 0; i < UNITS; i++) {
      const b = L.unitBase(i);
      o.push({ cool: st.i32[b + L.U_COOLDOWN],
               alive: st.i32[b + L.U_STATE] !== 0 && st.i32[b + L.U_HP] > 0,
               x: q(st.i32[b + L.U_X]), z: q(st.i32[b + L.U_Z]) });
    }
    return o;
  };
  // A read-only view of a unit for the pure target scans. Declared before the
  // loop that uses it: pickTarget and pickRifleTarget are pure and draw
  // nothing, which is what lets the rule's own choice be replayed here.
  const peek = (k) => {
    const bb = L.unitBase(k);
    return { x: st.i32[bb + L.U_X], z: st.i32[bb + L.U_Z], hp: st.i32[bb + L.U_HP],
             side: st.i32[bb + L.U_SIDE], armour: isArmour(k) };
  };
  let prev = cool();
  let hpWas = hp0;
  const tally = { tank: 0, rifle: 0, ambiguous: 0, tankShots: 0, rifleShots: 0,
                  gunShots: 0, engagedShots: 0, wouldCourier: 0, marginal: 0, diedAt: 0, guardWouldPass: 0, rifleCourier: 0 };
  const prevGun = [];
  for (let i = 0; i < UNITS; i++) prevGun[i] = st.i32[L.unitBase(i) + L.U_TARGET];
  for (let f = 0; f < ref.setup.durationSeconds * 60; f++) {
    step(st, 0, 0, 0, 0, 0);
    holdAir(st);
    // Which weapons fired at the truck this tick, and how many points landed.
    const now = cool();
    const tx0 = q(st.i32[T + L.T_X]), tz0 = q(st.i32[T + L.T_Z]);
    let tShots = 0, rShots = 0, courierThisTick = 0, rCourierTick = 0;
    for (let i = 0; i < UNITS; i++) {
      const a = prev[i], b = now[i];
      if (!a.alive || !b.alive || b.cool <= a.cool) continue;
      if (Math.hypot(b.x - tx0, b.z - tz0) >= RIFLE_R) continue;
      // A tank has no private courier clock any more - its courier shots are
      // gun shots whose target choice fell on the truck, and those are counted
      // by the predicate replay below. What is left in the 40-99 band is a
      // core that still carries the deleted weapon, which is how this tool
      // stays readable against an older build.
      if (isArmour(i)) { if (b.cool >= TANK_CLOCK[0] && b.cool <= TANK_CLOCK[1]) tShots++; }
      else if (b.cool >= RIFLE_CLOCK[0]) {
        // A reload-band write by a man near the truck is a SHOT, but after
        // (j) it is only a shot AT THE TRUCK when he had a foe and the truck
        // was nearer. Replayed the way the rule decides it: pickRifleTarget is
        // pure and draws nothing.
        rShots++;
        const bb = L.unitBase(i);
        const f2 = pickRifleTarget(peek, UNITS, i, st.i32[bb + L.U_X], st.i32[bb + L.U_Z],
                                   st.i32[bb + L.U_SIDE]);
        if (f2 >= 0) {
          const f2b = L.unitBase(f2);
          const cdr = Math.hypot(q(st.i32[bb + L.U_X]) - tx0, q(st.i32[bb + L.U_Z]) - tz0);
          const fdr = Math.hypot(q(st.i32[bb + L.U_X] - st.i32[f2b + L.U_X]),
                                 q(st.i32[bb + L.U_Z] - st.i32[f2b + L.U_Z]));
          if (cdr < RIFLE_R && cdr < fdr) { tally.rifleCourier++; rCourierTick++; }
        }
      }
    }
    tally.tankShots += tShots; tally.rifleShots += rShots;

    // WHAT (j) WILL DO, measured on today's core before a rule line moves.
    //
    // After the rewrite a tank has ONE clock: it fires when pickTarget found a
    // foe, and it aims at the truck instead only when the truck is inside
    // CourierRange AND nearer than that foe (Army.cs:696-706, Heat at zero).
    // Both halves are readable now - pickTarget is exported and pure, it draws
    // nothing, and the truck is in the core's own words. So the courier shot
    // count after (j) can be PREDICTED rather than estimated.
    //
    // Read at the end of the tick, where the rule reads it mid-loop: a tank
    // moves at most 7 m/s, so a shot within a tenth of a metre of the 34 m
    // gate could fall either way. Those are counted and printed as marginal.
    for (let i = 0; i < UNITS; i++) {
      if (!isArmour(i)) continue;
      const bb = L.unitBase(i);
      const t = st.i32[bb + L.U_TARGET];
      if (!(prevGun[i] <= 0 && t >= GUN_CLOCK[0] && t <= GUN_CLOCK[1])) continue;
      tally.gunShots++;
      const ux = st.i32[bb + L.U_X], uz = st.i32[bb + L.U_Z];
      const foe = pickTarget(peek, UNITS, i, ux, uz, st.i32[bb + L.U_SIDE]);
      if (foe < 0) continue;                       // not engaged: the C# would not fire
      tally.engagedShots++;
      const fb = L.unitBase(foe);
      const cd = Math.hypot(q(ux) - tx0, q(uz) - tz0);
      const fd = Math.hypot(q(ux - st.i32[fb + L.U_X]), q(uz - st.i32[fb + L.U_Z]));
      if (cd < COURIER_RANGE && cd < fd) {
        tally.wouldCourier++;
        courierThisTick++;
      }
      if (Math.abs(cd - COURIER_RANGE) < 0.5 || Math.abs(cd - fd) < 0.5) tally.marginal++;
      // (m)'s guard, checked rather than trusted. The axis test is only a
      // cheap pre-filter - it passes everything inside a 68 x 68 m square and
      // length2 then rejects the corners, which is the arithmetic working, not
      // a fault. The FAULT would be length2 answering "inside 34 m" for a tank
      // that is not, which is what the overflow did past ~181.5 m. So the rule
      // is run as the rule runs it, in fixed point, and disagreements with the
      // true distance are counted.
      const dxfx = sub(ux, fx(tx0)), dzfx = sub(uz, fx(tz0));
      const ruleSays = abs(dxfx) <= CR_FX && abs(dzfx) <= CR_FX && length2(dxfx, dzfx) < CR_FX;
      if (ruleSays !== (cd < COURIER_RANGE)) tally.guardWouldPass++;
    }
    for (let i = 0; i < UNITS; i++) prevGun[i] = st.i32[L.unitBase(i) + L.U_TARGET];
    const landed = q(hpWas - st.i32[T + L.T_HP]);
    hpWas = st.i32[T + L.T_HP];
    if (landed > 0) {
      // Split by the SIZE of the hit, which is exactly how the recorder does
      // it and is possible for the first time now that a tank writes 5-11 and
      // a rifleman one. A tick carrying both is counted as ambiguous and
      // printed rather than apportioned.
      if (courierThisTick > 0 && rCourierTick === 0) tally.tank += landed;
      else if (rCourierTick > 0 && courierThisTick === 0) tally.rifle += landed;
      else tally.ambiguous += landed;
    }
    if (tally.diedAt === 0 && st.i32[T + L.T_HP] <= 0) tally.diedAt = (f + 1) / 60;
    prev = now;
    if ((f + 1) % SAMPLE) continue;
    const tx = q(st.i32[T + L.T_X]), tz = q(st.i32[T + L.T_Z]);
    let inRifle = 0, inTank = 0;
    for (let i = 0; i < UNITS; i++) {
      const b = L.unitBase(i);
      if (st.i32[b + L.U_STATE] === 0 || st.i32[b + L.U_HP] <= 0) continue;
      const d = Math.hypot(q(st.i32[b + L.U_X]) - tx, q(st.i32[b + L.U_Z]) - tz);
      if (isArmour(i)) { if (d < COURIER_RANGE) inTank++; }
      else if (d < RIFLE_R) inRifle++;
    }
    rows.push({ t: (f + 1) / 60, dmg: q(hp0 - st.i32[T + L.T_HP]), inRifle, inTank,
                x: tx, z: tz, ...tally });
  }
  return rows;
}

for (const seed of SEEDS) {
  const rows = measure(seed);
  const pair = seed === ref.setup.seed;
  console.log('');
  console.log(`COURIER seed=${seed}${SEAM0 ? ' seam0' : ''}` +
              (pair ? '   REC column is the recording\'s courier pass' : '   (the recording holds only its own seed - no REC cells)'));
  console.log('COURIER    t   core dmg  inRifle  inTank  |  REC totalDmg  rifleHits  tankHits  inRifle  inTank');
  rows.forEach((r, k) => {
    const c = pair ? REC[k] : null;
    console.log(`COURIER  ${String(r.t).padStart(3)}   ${r.dmg.toFixed(2).padStart(8)}  ` +
                `${String(r.inRifle).padStart(7)}  ${String(r.inTank).padStart(6)}  | ` +
                (c ? `${c.totalDmg.toFixed(2).padStart(11)}  ${String(c.rifleHits).padStart(9)}  ` +
                     `${String(c.tankHits).padStart(8)}  ${String(c.inRifle).padStart(7)}  ${String(c.inTank).padStart(6)}`
                   : '          -'));
  });
  const last = rows[rows.length - 1];
  console.log(`COURIER  the truck ended at (${last.x.toFixed(2)}, ${last.z.toFixed(2)}) - it must not have moved`);
  if (pair) {
    const c = REC[REC.length - 1];
    console.log('');
    console.log('COURIER  AT NINETY SECONDS          core        recording');
    console.log(`COURIER    total damage        ${last.dmg.toFixed(2).padStart(10)}  ${c.totalDmg.toFixed(2).padStart(12)}`);
    console.log(`COURIER    of it, tank         ${last.tank.toFixed(2).padStart(10)}  ${c.tankDmg.toFixed(2).padStart(12)}   (${c.tankHits} hits)`);
    console.log(`COURIER    of it, rifle        ${last.rifle.toFixed(2).padStart(10)}  ${c.rifleDmg.toFixed(2).padStart(12)}   (${c.rifleHits} hits)`);
    console.log(`COURIER    of it, ambiguous    ${last.ambiguous.toFixed(2).padStart(10)}` +
                '               -   both weapons in one tick');
    console.log(`COURIER    riflemen within ${RIFLE_R} m ${String(last.inRifle).padStart(9)}  ${String(c.inRifle).padStart(12)}`);
    console.log(`COURIER    tanks within ${COURIER_RANGE} m    ${String(last.inTank).padStart(9)}  ${String(c.inTank).padStart(12)}`);
    console.log('');
    console.log('COURIER  WHERE THE CORE\'S POINTS COME FROM, split by the clock that fired');
    console.log(`COURIER    rifle shots AT THE TRUCK (foe held, truck nearer)  ${last.rifleCourier}` +
                `   of ${last.rifleShots} rifle shots in reach`);
    console.log(`COURIER    at the rifle's 0.045 roll that is ${(last.rifleCourier * 0.045).toFixed(1)} hits,` +
                ` and at Rand(1.5,3.5) about ${(last.rifleCourier * 0.045 * 2.5).toFixed(1)} points`);
    console.log('COURIER    against the recording\'s 6 hits and 13.88');
    console.log(`COURIER    points landed          tank ${last.tank.toFixed(2)}   rifle ${last.rifle.toFixed(2)}` +
                `   ambiguous ${last.ambiguous.toFixed(2)}`);
    console.log('COURIER    ambiguous means both weapons fired in the same tick and the point');
    console.log('COURIER    cannot be attributed from outside. It is printed, not apportioned.');
    console.log('');
    console.log('COURIER  WHAT (j) WILL DO, predicted from today\'s core, no rule moved');
    console.log(`COURIER    tank GUN shots this round                 ${last.gunShots}`);
    console.log(`COURIER      of them with a foe inside ${q(ARMOUR_RANGE)} m       ${last.engagedShots}` +
                '   (the C# fires only when engaged)');
    console.log(`COURIER      of THOSE, truck inside ${COURIER_RANGE} m and nearer  ${last.wouldCourier}` +
                `   <- predicted courier shots`);
    console.log(`COURIER      marginal, within 0.5 m of either gate   ${last.marginal}`);
    console.log(`COURIER      (m)'s guard: shots where the rule's fixed-point reach disagrees`);
    console.log(`COURIER      with the true distance                  ${last.guardWouldPass}   <- must be 0`);
    const hits = last.wouldCourier * 0.55, pts = hits * 8;
    console.log(`COURIER    at the gun's 0.55 roll that is ${hits.toFixed(1)} hits, and at Rand(5,11)`);
    console.log(`COURIER    averaging 8 points, about ${pts.toFixed(0)} points - against the recording's`);
    console.log('COURIER    163 hits and 1271.7. THAT is the number the rewrite is held to;');
    console.log('COURIER    the rest of the gap is presence, and is not the rewrite\'s to close.');
    if (last.diedAt)
      console.log(`COURIER    NOTE: the core's truck has 100 points and died at t=${last.diedAt.toFixed(1)} s,` +
                  ' so the damage column saturates.\nCOURIER    Shots and hits are the unsaturated' +
                  ' acceptance; the recording accumulates past 100.');
  }
}
