// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// 0.10: A PRIVATE FINANCIAL WORLD PER PLAYER, AND THE GUARANTEE IS A MISSING
// PARAMETER.
//
//     financial_world(p) = deterministic_sim(RoundContract, map, player_seed,
//                                            player_inputs)
//     Ghost snapshots are never inputs to this calculation.
//     Alice's physics cannot change Bob's result.
//
// 0.9 says why it matters: "Another player must not be able to change my
// financial odds by ramming me, blocking a road, pushing me, damaging me,
// drawing my enemies away, pulling enemies toward me, sacrificing themselves
// for me, or colluding physically. Each player's enemies react only to that
// player's own truck in their financially relevant world."
//
// THIS FILE ASSERTS THE SHAPE, NOT A PROMISE ABOUT IT. A comment saying ghosts
// are not inputs is worth nothing; an argument list with nowhere to put one is
// worth something, and it is what this checks. It imports nothing from the
// protocol package on purpose: the guarantee is the core's own, and a test
// that reached for a ghost type to prove a ghost cannot arrive would be
// building the door it claims is absent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { init, step } from '../src/sim.js';
import * as state from '../src/state.js';
import { WORDS, O_TRUCK, TRUCK_WORDS, T_X, T_Z, T_HEADING } from '../src/state.js';

/**
 * `step` takes a state and one player's five inputs. There is no sixth thing
 * a competitor could arrive through, and this is the whole of 0.10 in one
 * number: a function that cannot be handed another truck cannot be moved by
 * one.
 */
test('the simulation takes one state and one player\'s inputs, and nothing else', () => {
  assert.equal(step.length, 6,
    'step grew an argument - if a ghost can be passed in, 0.10 is a comment');

  // and they are the five 0.10 names plus the declared practice flag: a
  // caller cannot even spell a competitor here
  assert.equal(step.toString().slice(0, step.toString().indexOf(')') + 1),
    'function step(st, throttle, steer, brake, handbrake, practice)');
});

/**
 * ONE TRUCK. The state is a flat array of words with a single `O_TRUCK` block
 * in it, so there is no second truck to write and no array to grow. A ghost
 * has nowhere to be stored even if something wanted to store one.
 */
test('the state holds one truck and has no room for another', () => {
  const st = init(1234);
  assert.equal(st.i32.length, WORDS);

  // the truck block is one block, not a stride into many
  assert.equal(O_TRUCK + TRUCK_WORDS <= WORDS, true);
  for (const field of [T_X, T_Z, T_HEADING])
    assert.equal(field < TRUCK_WORDS, true, 'a truck field lands outside the truck block');

  // there is exactly one of it: nothing in the state names a second
  const names = Object.keys(state);
  assert.equal(names.some((n) => /TRUCKS|O_GHOST|GHOSTS|OTHER_TRUCK/.test(n)), false,
    'the state grew somewhere to put another player');
});

/**
 * AND THE SAME INPUTS GIVE THE SAME RUN, which is the other half of 0.10:
 * "the shared competition is produced by comparing independent results". Two
 * runs of the same seed and the same inputs agree word for word, so nothing
 * outside those inputs is reaching the simulation.
 */
test('two runs of the same inputs agree word for word', () => {
  const drive = (seed) => {
    const st = init(seed);
    for (let t = 0; t < 120; t++) step(st, 65536, (t % 40) * 1000 - 20000, 0, 0, 0);
    return st;
  };
  assert.deepEqual(Array.from(drive(99).i32), Array.from(drive(99).i32));

  // and a different seed is a different run, so the comparison above is not
  // comparing two copies of nothing
  assert.notDeepEqual(Array.from(drive(99).i32), Array.from(drive(100).i32));
});
