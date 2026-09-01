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

/**
 * Set for any tick the run spent in practice mode.
 *
 * It lives in the HASHED state on purpose. Practice is not a cheat if it is
 * declared, and a verifier replaying a transcript sees this word set and can
 * refuse to settle the round - which is what makes it safe to offer at all.
 * A flag Unity kept to itself would be invisible to every node.
 */
export const S_PRACTICE = 6;

// unit fields, relative to a unit's base
export const U_X = 0, U_Z = 1, U_SIDE = 2, U_HP = 3;
export const U_HEADING = 4, U_STATE = 5, U_COOLDOWN = 6, U_TARGET = 7;

export function create() {
  const buffer = new ArrayBuffer(Math.imul(WORDS, 4));
  return { buffer, i32: new Int32Array(buffer), u8: new Uint8Array(buffer) };
}

export const unitBase = (i) => O_UNITS + Math.imul(i, U_WORDS);

/**
 * True on every machine this will realistically run on, and checked anyway.
 *
 * WebAssembly is defined as little-endian and every current CPU that runs a
 * browser agrees, so the fast path below is the only one that has ever been
 * taken. It is still worth writing the other one: the digest has to be a
 * property of the state's VALUES, not of the host's byte order, or a
 * big-endian verifier would reject every player without either side being
 * wrong.
 */
const LITTLE_ENDIAN = new Uint8Array(new Int32Array([1]).buffer)[0] === 1;

/**
 * Canonical hash of the whole state, little-endian by definition.
 *
 * Deliberately the entire buffer including padding: anything excluded is
 * something two implementations could differ on unnoticed.
 *
 * The endianness is the part that no test on this hardware could have caught.
 * Hashing the raw bytes of an Int32Array makes the digest depend on the
 * machine's byte order, and x86-64 and arm64 are both little-endian - so the
 * cross-architecture run proved the core agreed with itself while leaving the
 * assumption entirely unexamined.
 */
export function hash(st) {
  if (LITTLE_ENDIAN) return sha256hex(st.u8);

  const swapped = new Uint8Array(st.u8.length);
  for (let i = 0; i < st.i32.length; i++) {
    const v = st.i32[i], o = i << 2;
    swapped[o] = v & 255;
    swapped[o + 1] = (v >>> 8) & 255;
    swapped[o + 2] = (v >>> 16) & 255;
    swapped[o + 3] = (v >>> 24) & 255;
  }
  return sha256hex(swapped);
}

/** The byte order the protocol is defined in. Exposed so a test can assert it. */
export const CANONICAL_LITTLE_ENDIAN = true;
