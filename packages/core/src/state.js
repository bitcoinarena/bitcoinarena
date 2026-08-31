// All simulation state in ONE ArrayBuffer with a fixed, documented layout.
//
// Two properties fall out of the constraint and are worth it:
//
//   Hashing is canonical and trivial - sha256 over the bytes, no serialisation
//   step, no field-ordering question, nothing for two implementations to
//   disagree about.
//
//   A float cannot hide. Storing 1.5 into an Int32Array slot silently becomes
//   1; there is nowhere in the state for a fractional value to live. Combined
//   with hashing every 100 ticks in tests, a leaked float shows up as a hash
//   mismatch immediately rather than as a rare desync months later.

import { sha256hex } from './sha256.js';

export const MAX_UNITS = 256;

// word offsets into the Int32Array view
export const O_TICK = 0;
export const O_RNG = 1;          // 4 words
export const O_TRUCK = 5;        // 12 words
export const O_SCORE = 17;       // 6 words
export const O_UNITS = 24;       // MAX_UNITS * U_WORDS
export const U_WORDS = 8;
export const WORDS = O_UNITS + Math.imul(MAX_UNITS, U_WORDS);

// truck fields, relative to O_TRUCK
export const T_X = 0, T_Z = 1, T_HEADING = 2, T_VX = 3, T_VZ = 4;
export const T_ANGVEL = 5, T_HP = 6, T_CARGO = 7, T_FLAGS = 8;
export const T_WHEEL = 9, T_THROTTLE = 10, T_STEER = 11;

// score fields, relative to O_SCORE
export const S_EXPOSURE = 0, S_ELAPSED = 1, S_BESTX = 2;
export const S_CARGO = 3, S_DELIVERED = 4, S_STATE = 5;

// unit fields, relative to a unit's base
export const U_X = 0, U_Z = 1, U_SIDE = 2, U_HP = 3;
export const U_HEADING = 4, U_STATE = 5, U_COOLDOWN = 6, U_TARGET = 7;

export function create() {
  const buffer = new ArrayBuffer(Math.imul(WORDS, 4));
  return { buffer, i32: new Int32Array(buffer), u8: new Uint8Array(buffer) };
}

export const unitBase = (i) => O_UNITS + Math.imul(i, U_WORDS);

/**
 * Canonical hash of the whole state.
 *
 * Deliberately the entire buffer including padding: anything excluded is
 * something two implementations could differ on unnoticed.
 */
export const hash = (st) => sha256hex(st.u8);
