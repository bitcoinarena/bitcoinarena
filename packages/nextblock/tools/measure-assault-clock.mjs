// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ASSAULT IN THE WORDS A PLAYER WOULD SEE (2026-09-20 16:22 / 16:26).
//
// `measure-assault.mjs` already measures WAR_TACTICS §4.12 against its §0.1 rows - declared-then-happens, the
// lulls, the win/fail split, the push. This asks a different and much smaller question, and only because the
// letter asks it: over a whole block, WHAT WOULD THE BANNER AND THE DESKTOP LOG HAVE SAID, and when? It prints
// the same three moments `AssaultWatch` turns into words, with the block clock on each, so the lines the owner
// reads on screen can be checked against the core that produced them rather than against a screenshot.
//
// It also counts the attacking side's tanks within 6 m of the target lane, which is the "tanks push that lane"
// half of the letter in the crudest possible form; the honest version of that number is measure-assault.mjs's.

const ONE = 65536, M = (q) => q / ONE;
const PHASE = ['IDLE', 'PUSH', 'CONSOLIDATE'];
const SIDES = [{ si: 0, side: -1, name: 'BULLS' }, { si: 1, side: 1, name: 'BEARS' }];
const OBJ = ['HIGH', 'LOW', 'OPEN'];   // OBJ_RIDGE 0, OBJ_HOLLOW 1, OBJ_GAP 2 - the client's own ObjectiveName mapping
const clock = (t) => {
  const s = Math.floor(t / 60);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

const seeds = process.argv.slice(2).map(Number);
const list = seeds.length ? seeds : [1, 2, 3, 4, 5];
let totalStarts = 0, totalWins = 0, totalFails = 0;

for (const seed of list) {
  const st = init(seed), s = st.i32;
  const was = [0, 0], events = [];
  // tank x on the target lane against the same side's tanks off it, sampled while a push is on
  const pushSamples = [];
  for (let t = 0; t < BLOCK_TICKS; t++) {
    step(st, 0, 0, 65536, 0, 0);                            // braked: the truck is not the subject here
    for (const { si, side, name } of SIDES) {
      const phase = assaultPhase(s, O_TACTICS, side);
      if (phase !== was[si]) {
        const target = assaultTarget(s, O_TACTICS, side);
        const holder = objectiveHolder(s, O_TACTICS, Math.min(target, 2));
        const mine = side < 0 ? 1 : 2;                       // HOLDER_BULL 1 / HOLDER_BEAR 2 in tactics.js
        let word;
        if (phase === 1) { word = `${name} ASSAULT ${OBJ[Math.min(target, 2)]}`; totalStarts++; }
        else if (phase === 2) { word = `${name}: ${OBJ[Math.min(target, 2)]} TAKEN`; totalWins++; }
        else word = was[si] === 1 ? `${name}: ASSAULT ON ${OBJ[Math.min(target, 2)]} FAILS` : `${name} consolidated`;
        if (!(phase === 0 && was[si] === 2)) events.push(`    [${clock(t)}] t${String(t).padStart(5)}  ${word}`
          + `   (holder now ${holder === mine ? 'THEIRS' : holder === 0 ? 'nobody' : 'the enemy'})`);
        if (was[si] === 1 && phase === 0) totalFails++;
        was[si] = phase;
      }
      // while this side pushes, where are its tanks relative to the target lane?
      if (phase === 1 && t % 120 === 0) {
        const target = assaultTarget(s, O_TACTICS, side);
        const laneX = M(slotX(objectiveLane(s, O_TACTICS, Math.min(target, 2))));
        let onLane = 0, onLaneZ = 0, off = 0, offZ = 0;
        for (let u = 0; u < UNITS; u++) {
          if ((u & ARMOUR_MASK) !== 0) continue;             // tanks only: men are the other three of every four
          const b = unitBase(u);
          if (s[b + U_HP] <= 0) continue;
          if (Math.sign(s[b + U_SIDE]) !== side) continue;
          const x = M(s[b + U_X]), z = M(s[b + U_Z]);
          if (Math.abs(x - laneX) <= 6) { onLane++; onLaneZ += z; } else { off++; offZ += z; }
        }
        if (onLane) pushSamples.push({ t, laneX, onLane, z: onLaneZ / onLane, off, offZ: off ? offZ / off : NaN });
      }
    }
  }
  console.log(`\nSEED ${seed} - ${events.length} assault events in a ${BLOCK_TICKS}-tick block (${clock(BLOCK_TICKS)})`);
  for (const e of events) console.log(e);
  console.log(`  bull assaults started ${assaultCount(s, O_TACTICS, -1)}, bear ${assaultCount(s, O_TACTICS, 1)}`);
  if (pushSamples.length) {
    const first = pushSamples[0], last = pushSamples[pushSamples.length - 1];
    console.log(`  tanks ON the target lane: ${first.onLane} at t${first.t} (z ${first.z.toFixed(1)})`
      + ` .. ${last.onLane} at t${last.t} (z ${last.z.toFixed(1)});  off-lane tanks ${last.off}`
      + (Number.isNaN(last.offZ) ? '' : ` at z ${last.offZ.toFixed(1)}`));
  } else console.log('  NO tank was ever within 6 m of the target lane during a push');
}
console.log(`\n  ${totalStarts} assaults started, ${totalWins} took the objective, ${totalFails} failed, over ${list.length} seeds.`);
