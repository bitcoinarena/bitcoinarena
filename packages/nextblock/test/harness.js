// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// The cross-engine harness: the acceptance criterion for stage 0.
//
// Runs a fixed input sequence and prints a state hash every thousand ticks.
// Any two runtimes that disagree on any line have a determinism bug, and the
// tick number says where to start looking.
//
// Deliberately free of host APIs: no file IO, no timers, no console assumption.
// The engine shells expose print(); Node exposes console.log.

import { init, step } from '../src/sim.js';
import { hash } from '../src/state.js';

const say = (m) => {
  if (typeof print === 'function') print(m);
  else console.log(m);
};

// Ten minutes, near enough: 36000 x 1092/65536 is 599.85 seconds, because the
// tick is not a sixtieth of a second (`src/tick.js`). The corpus is a COUNT OF
// TICKS and that count is what two runtimes have to agree on, so the number
// stays where it is - the duration is a description of it, not its definition.
// The acceptance criterion asks for ten minutes of run. The
// first version ran 10,000 ticks - under three minutes - and a divergence that
// takes four minutes of accumulated rounding to surface would have passed it.
const TICKS = 36000;
const SEED = 0x5eed1234;

/**
 * The input sequence is generated, not recorded, so the harness needs no
 * fixture file - and it is generated from an integer LCG rather than the
 * simulation's own RNG, so a bug in one cannot mask a bug in the other.
 */
function inputs(t) {
  const a = (Math.imul(t, 1103515245) + 12345) | 0;
  const b = (Math.imul(a, 1103515245) + 12345) | 0;
  return {
    throttle: 32768 + ((a >>> 17) % 32769),
    steer: ((b >>> 16) % 65536) - 32768,
    brake: (t % 700) < 40 ? 65536 : 0,
  };
}

const st = init(SEED);
say('# blwp core harness');
say('# ticks=' + TICKS + ' seed=' + SEED);

for (let t = 0; t < TICKS; t++) {
  const i = inputs(t);
  step(st, i.throttle, i.steer, i.brake, 0, 0);
  if ((t + 1) % 3600 === 0) say((t + 1) + ' ' + hash(st));
}
say('final ' + hash(st));
