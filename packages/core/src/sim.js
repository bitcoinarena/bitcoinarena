// A tick of the world, in integers only.
//
// This is deliberately small: a vehicle, a handful of units, and the score
// terms. It exists to answer the spike's question - does the same code produce
// the same bytes in every engine - and to be the skeleton the real rules are
// hung on in stage 1.
//
// Every random draw takes the state's own stream and the ORDER OF DRAWS IS
// PROTOCOL. Anything added here must be added at the end of a tick's draws,
// never in the middle, or every existing transcript stops replaying.

import { ONE, add, sub, mulFast, div, clamp, abs, min, max, sqrt, length2 } from './fixed.js';
import { next, below, seed } from './rng.js';
import { sin, cos, atan2 } from './trig.js';
import {
  create, unitBase, MAX_UNITS,
  O_TICK, O_RNG, O_TRUCK, O_SCORE,
  T_X, T_Z, T_HEADING, T_VX, T_VZ, T_ANGVEL, T_HP, T_CARGO, T_FLAGS,
  T_WHEEL, T_THROTTLE, T_STEER,
  S_EXPOSURE, S_ELAPSED, S_BESTX, S_CARGO, S_DELIVERED, S_STATE,
  U_X, U_Z, U_SIDE, U_HP, U_HEADING, U_STATE, U_COOLDOWN, U_TARGET,
} from './state.js';

// world constants, all Q16.16
const MAP_HALF_X = Math.imul(130, ONE);
const MAP_HALF_Z = Math.imul(85, ONE);
const GATE_X = Math.imul(114, ONE);
const TICK_HZ = 60;

// vehicle, derived from the raycast-vehicle family rather than from PhysX:
// a drive force along the heading, a lateral friction that bleeds sideways
// velocity, and a linear drag. Grip is the one number that will need the most
// tuning against feel in stage 1.
// About 5 m/s^2 at full throttle: 5/60 of a metre per second per tick, which is
// 5460 in Q16.16. Feel is stage 1 work with a human at the wheel; this is only
// enough to make the spike's ten thousand ticks cover ground.
const DRIVE = 5400;
const BRAKE = 9000;
const DRAG = 240;             // per tick, proportional
const GRIP = 46000;           // 0..65536, how much lateral velocity is killed
const STEER_RATE = 260;       // Q16.16 turns per tick at full lock
const MAX_SPEED = Math.imul(28, ONE);

const UNIT_COUNT = 48;
const UNIT_SPEED = 3200;
const RIFLE_RANGE = Math.imul(26, ONE);

/** Fresh world. `seedWord` is the player's sub-seed folded to 32 bits. */
export function init(seedWord) {
  const st = create();
  const s = st.i32;
  seed(s.subarray(O_RNG, O_RNG + 4), seedWord);
  const rng = s.subarray(O_RNG, O_RNG + 4);

  s[O_TICK] = 0;
  s[O_TRUCK + T_X] = Math.imul(-114, ONE);
  s[O_TRUCK + T_Z] = Math.imul(-78, ONE);
  // A quarter turn: heading 0 faces +Z by the sin/cos convention, and the run
  // goes down +X towards the gate.
  s[O_TRUCK + T_HEADING] = 16384;
  s[O_TRUCK + T_HP] = Math.imul(100, ONE);
  s[O_TRUCK + T_CARGO] = 0;
  s[O_SCORE + S_BESTX] = s[O_TRUCK + T_X];

  for (let i = 0; i < UNIT_COUNT; i++) {
    const b = unitBase(i);
    // draws, in order: x, z, side, hp jitter
    s[b + U_X] = Math.imul(below(rng, 200) - 100, ONE);
    s[b + U_Z] = Math.imul(below(rng, 160) - 80, ONE);
    s[b + U_SIDE] = below(rng, 2) === 0 ? -1 : 1;
    s[b + U_HP] = Math.imul(60 + below(rng, 40), ONE);
    s[b + U_HEADING] = below(rng, 65536);
    s[b + U_STATE] = 1;
    s[b + U_COOLDOWN] = below(rng, 120);
    s[b + U_TARGET] = -1;
  }
  return st;
}

/**
 * One tick. `throttle`, `steer` and `brake` are Q16.16 in [-1, 1].
 *
 * Order matters and is fixed: vehicle first, then units, then score. Anything
 * inserted between them changes every hash that has ever been produced.
 */
export function step(st, throttle, steer, brake) {
  const s = st.i32;
  const rng = s.subarray(O_RNG, O_RNG + 4);
  const T = O_TRUCK;

  s[O_TICK] = (s[O_TICK] + 1) | 0;
  s[T + T_THROTTLE] = clamp(throttle, -ONE, ONE);
  s[T + T_STEER] = clamp(steer, -ONE, ONE);

  // ---- vehicle -----------------------------------------------------------
  const heading = s[T + T_HEADING];
  const fx = sin(heading), fz = cos(heading);

  let vx = s[T + T_VX], vz = s[T + T_VZ];
  const speed = length2(vx, vz);

  // drive along the nose
  const push = mulFast(s[T + T_THROTTLE], DRIVE);
  vx = add(vx, mulFast(fx, push));
  vz = add(vz, mulFast(fz, push));

  // brake opposes motion
  if (brake > 0 && speed > 0) {
    const b = mulFast(brake, BRAKE);
    const bx = div(mulFast(vx, b), speed);
    const bz = div(mulFast(vz, b), speed);
    vx = sub(vx, bx); vz = sub(vz, bz);
  }

  // lateral grip: split into along/across the nose, bleed the across part
  const along = add(mulFast(vx, fx), mulFast(vz, fz));
  const across = sub(mulFast(vx, fz), mulFast(vz, fx));
  const kept = mulFast(across, sub(ONE, GRIP));
  vx = add(mulFast(along, fx), mulFast(kept, fz));
  vz = sub(mulFast(along, fz), mulFast(kept, fx));

  // drag
  vx = sub(vx, mulFast(vx, DRAG));
  vz = sub(vz, mulFast(vz, DRAG));

  // speed cap
  const sp2 = length2(vx, vz);
  if (sp2 > MAX_SPEED) {
    vx = div(mulFast(vx, MAX_SPEED), sp2);
    vz = div(mulFast(vz, MAX_SPEED), sp2);
  }

  // steering scales with how fast you are going
  const bite = div(min(sp2, MAX_SPEED), MAX_SPEED);
  s[T + T_HEADING] = (heading + mulFast(mulFast(s[T + T_STEER], bite), STEER_RATE)) & 65535;

  s[T + T_VX] = vx; s[T + T_VZ] = vz;
  s[T + T_X] = clamp(add(s[T + T_X], div(vx, Math.imul(TICK_HZ, ONE))), -MAP_HALF_X, MAP_HALF_X);
  s[T + T_Z] = clamp(add(s[T + T_Z], div(vz, Math.imul(TICK_HZ, ONE))), -MAP_HALF_Z, MAP_HALF_Z);

  // ---- units -------------------------------------------------------------
  const tx = s[T + T_X], tz = s[T + T_Z];
  let threat = 0;
  for (let i = 0; i < UNIT_COUNT; i++) {
    const b = unitBase(i);
    if (s[b + U_HP] <= 0) continue;

    // walk toward the seam at z = 0, with a per-unit wobble drawn every tick
    const wob = (below(rng, 64) - 32) | 0;
    s[b + U_HEADING] = (s[b + U_HEADING] + wob) & 65535;
    const ux = sin(s[b + U_HEADING]), uz = cos(s[b + U_HEADING]);
    const toSeam = s[b + U_Z] > 0 ? -1 : 1;
    s[b + U_X] = clamp(add(s[b + U_X], div(mulFast(ux, UNIT_SPEED), Math.imul(TICK_HZ, ONE))),
                       -MAP_HALF_X, MAP_HALF_X);
    s[b + U_Z] = clamp(add(s[b + U_Z], div(mulFast(uz, Math.imul(UNIT_SPEED, toSeam)), Math.imul(TICK_HZ, ONE))),
                       -MAP_HALF_Z, MAP_HALF_Z);

    // in range of the courier?
    const dx = sub(s[b + U_X], tx), dz = sub(s[b + U_Z], tz);
    const d = length2(dx, dz);
    if (d < RIFLE_RANGE) {
      threat = (threat + 1) | 0;
      if (s[b + U_COOLDOWN] > 0) s[b + U_COOLDOWN] = (s[b + U_COOLDOWN] - 1) | 0;
      else {
        s[b + U_COOLDOWN] = (40 + below(rng, 60)) | 0;
        if (below(rng, 1000) < 45) {
          s[T + T_HP] = max(0, sub(s[T + T_HP], ONE));
        }
      }
    }
  }

  // ---- score -------------------------------------------------------------
  // Exposure integrates danger over GROUND MADE GOOD, against a high-water
  // mark, so circling earns nothing - the rule from spec 18A.
  const bestX = s[O_SCORE + S_BESTX];
  if (s[T + T_X] > bestX) {
    const gained = sub(s[T + T_X], bestX);
    const rate = div(min(Math.imul(threat, ONE), Math.imul(10, ONE)), Math.imul(10, ONE));
    s[O_SCORE + S_EXPOSURE] = add(s[O_SCORE + S_EXPOSURE], mulFast(rate, gained));
    s[O_SCORE + S_BESTX] = s[T + T_X];
  }
  s[O_SCORE + S_ELAPSED] = (s[O_SCORE + S_ELAPSED] + 1) | 0;
  if (s[T + T_X] >= GATE_X && s[O_SCORE + S_STATE] === 0) s[O_SCORE + S_STATE] = 1;
  return st;
}
