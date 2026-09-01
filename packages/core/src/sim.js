// One tick of the world.
//
// The rules live in src/rules/*; this file is only the order they run in - and
// that order IS PROTOCOL. Vehicle, then army, then score, then outcome. A rule
// inserted between two of them changes every hash ever produced, so new work
// goes at the end of a phase, never in the middle.
//
// The same applies to random draws: each unit draws its wobble, and only then,
// and only if in range, its reload and hit roll. That sequence is the reason a
// transcript recorded today can still be replayed next year.

import { ONE, add, sub, mulFast, div, clamp, min, max, abs, length2 } from './fixed.js';
import { seed } from './rng.js';
import { sin, cos } from './trig.js';
import {
  create, unitBase, MAX_UNITS,
  O_TICK, O_RNG, O_TRUCK, O_SCORE,
  T_X, T_Z, T_HEADING, T_VX, T_VZ, T_ANGVEL, T_HP, T_CARGO, T_FLAGS,
  T_WHEEL, T_THROTTLE, T_STEER,
  S_EXPOSURE, S_ELAPSED, S_BESTX, S_CARGO, S_DELIVERED, S_STATE,
  U_X, U_Z, U_SIDE, U_HP, U_HEADING, U_STATE, U_COOLDOWN, U_TARGET,
} from './state.js';
import * as vehicle from './rules/vehicle.js';
import * as army from './rules/army.js';
import * as scoring from './rules/score.js';
import * as gate from './rules/gate.js';
import { frontlineZ, SAMPLES } from './rules/frontline.js';

export const UNITS = 96;
export const HALF_X = Math.imul(130, ONE);
export const HALF_Z = Math.imul(85, ONE);
const TICK_DT = 1092;                       // 1/60 in Q16.16
const START_X = Math.imul(-114, ONE);
const START_Z = Math.imul(-78, ONE);        // bay 1
// Every fourth unit is armour. A mask rather than a modulo: '%' is banned
// outside the arithmetic files, and a power of two makes the ban free.
const ARMOUR_MASK = 3;

/** A price tape, so the frontline has something to follow. */
function tape(rngWords) {
  const h = new Int32Array(SAMPLES);
  let p = Math.imul(78000, ONE >> 8);
  for (let i = 0; i < SAMPLES; i++) {
    const step = ((Math.imul(i + 1, 2654435761) >>> 20) - 2048) | 0;
    p = add(p, Math.imul(step, 64));
    h[i] = p;
  }
  return h;
}

export function init(seedWord) {
  const st = create();
  const s = st.i32;
  const rng = s.subarray(O_RNG, O_RNG + 4);
  seed(rng, seedWord);

  s[O_TRUCK + T_X] = START_X;
  s[O_TRUCK + T_Z] = START_Z;
  s[O_TRUCK + T_HEADING] = 16384;           // facing +x, down the map
  s[O_TRUCK + T_HP] = Math.imul(100, ONE);
  s[O_TRUCK + T_CARGO] = 45875;             // 0.7 of a bed
  s[O_SCORE + S_BESTX] = START_X;
  s[O_SCORE + S_CARGO] = 45875;
  s[O_SCORE + S_STATE] = gate.RUN_LIVE;

  st.tape = tape(rng);

  for (let i = 0; i < UNITS; i++) {
    const b = unitBase(i);
    // draw order: x, z, side, hp, heading, cooldown
    s[b + U_X] = Math.imul(nextBelow(rng, 200) - 100, ONE);
    s[b + U_Z] = Math.imul(nextBelow(rng, 160) - 80, ONE);
    s[b + U_SIDE] = nextBelow(rng, 2) === 0 ? -1 : 1;
    s[b + U_HP] = Math.imul(60 + nextBelow(rng, 40), ONE);
    s[b + U_HEADING] = nextBelow(rng, 65536);
    s[b + U_STATE] = 1;
    s[b + U_COOLDOWN] = nextBelow(rng, 120);
    s[b + U_TARGET] = -1;
  }
  return st;
}

// re-exported so the draw order lives in one place
import { below } from './rng.js';
const nextBelow = below;

export function step(st, throttle, steer, brake, handbrake) {
  const s = st.i32;
  const rng = s.subarray(O_RNG, O_RNG + 4);
  const T = O_TRUCK;
  s[O_TICK] = (s[O_TICK] + 1) | 0;

  // ---- 1. vehicle --------------------------------------------------------
  const v = {
    x: s[T + T_X], z: s[T + T_Z], heading: s[T + T_HEADING],
    vx: s[T + T_VX], vz: s[T + T_VZ], angVel: s[T + T_ANGVEL],
    steerAngle: s[T + T_STEER], speed: 0,
  };
  vehicle.step(v, throttle, steer, brake, handbrake, TICK_DT);
  s[T + T_X] = clamp(v.x, -HALF_X, HALF_X);
  s[T + T_Z] = clamp(v.z, -HALF_Z, HALF_Z);
  s[T + T_HEADING] = v.heading;
  s[T + T_VX] = v.vx; s[T + T_VZ] = v.vz;
  s[T + T_ANGVEL] = v.angVel; s[T + T_STEER] = v.steerAngle;
  s[T + T_WHEEL] = v.speed;
  s[T + T_THROTTLE] = throttle;

  // ---- 2. army -----------------------------------------------------------
  const tx = s[T + T_X], tz = s[T + T_Z];
  const seamZ = frontlineZ(st.tape, tx, HALF_X, HALF_Z);
  let hits = 0;
  const u = { x: 0, z: 0, hp: 0, heading: 0, cooldown: 0, armour: false };
  for (let i = 0; i < UNITS; i++) {
    const b = unitBase(i);
    u.x = s[b + U_X]; u.z = s[b + U_Z]; u.hp = s[b + U_HP];
    u.heading = s[b + U_HEADING]; u.cooldown = s[b + U_COOLDOWN];
    const r = army.stepUnit(u, rng, seamZ, tx, tz, HALF_X, HALF_Z, TICK_DT);
    s[b + U_X] = u.x; s[b + U_Z] = u.z;
    s[b + U_HEADING] = u.heading; s[b + U_COOLDOWN] = u.cooldown;
    if (r === 2) hits = (hits + 1) | 0;
  }
  if (hits > 0 && s[O_SCORE + S_STATE] === gate.RUN_LIVE)
    s[T + T_HP] = max(0, sub(s[T + T_HP], Math.imul(hits, ONE)));

  // ---- 3. score ----------------------------------------------------------
  // danger is guns in range, not distance to a line
  const view = (i) => {
    const b = unitBase(i);
    return { x: s[b + U_X], z: s[b + U_Z], hp: s[b + U_HP],
             armour: (i & ARMOUR_MASK) === 0 };
  };
  const fromStart = length2(sub(tx, START_X), sub(tz, START_Z));
  const gaining = tx > s[O_SCORE + S_BESTX];
  if (scoring.earning(fromStart, gaining) && s[O_SCORE + S_STATE] === gate.RUN_LIVE) {
    const threat = army.threatAt(view, UNITS, tx, tz);
    s[O_SCORE + S_EXPOSURE] = scoring.accrue(
      s[O_SCORE + S_EXPOSURE], s[O_SCORE + S_BESTX], tx, threat, s[O_SCORE + S_CARGO]);
  }
  if (gaining) s[O_SCORE + S_BESTX] = tx;
  if (s[O_SCORE + S_STATE] === gate.RUN_LIVE)
    s[O_SCORE + S_ELAPSED] = (s[O_SCORE + S_ELAPSED] + 1) | 0;

  // ---- 4. outcome --------------------------------------------------------
  s[O_SCORE + S_STATE] = gate.outcome(
    s[O_SCORE + S_STATE], tx, tz, s[T + T_HP], s[O_SCORE + S_ELAPSED]);
  if (s[O_SCORE + S_STATE] === gate.RUN_DELIVERED && s[O_SCORE + S_DELIVERED] === 0)
    s[O_SCORE + S_DELIVERED] = scoring.score(
      s[O_SCORE + S_EXPOSURE], s[O_SCORE + S_ELAPSED], s[O_SCORE + S_CARGO]);
  return st;
}

export const runScore = (st) =>
  scoring.score(st.i32[O_SCORE + S_EXPOSURE],
                st.i32[O_SCORE + S_ELAPSED],
                st.i32[O_SCORE + S_CARGO]);
