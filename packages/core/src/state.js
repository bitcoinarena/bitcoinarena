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

/**
 * The army's replacement clocks: how long until the next unit walks on, per
 * side and per arm, in Q16.16 seconds.
 *
 * Appended AFTER the units so that every offset above this line stayed where
 * it was. Growing the state moves every golden vector hash, but so does
 * reinforcement itself - the checkpoints cover the whole buffer, including all
 * ninety-six unit positions - so there is no layout that would have avoided
 * regenerating them. The honest one is the one that reads.
 *
 * They are STATE rather than locals for the reason everything else here is:
 * a verifier replaying a transcript has to arrive at the same bytes, and a
 * timer living outside the buffer is a timer two implementations can disagree
 * about without either one noticing.
 */
export const O_ARMY = O_UNITS + Math.imul(MAX_UNITS, U_WORDS);
export const A_ARMOUR_BULL = 0, A_ARMOUR_BEAR = 1;
export const A_RIFLE_BULL = 2, A_RIFLE_BEAR = 3;
export const A_WORDS = 4;

/**
 * The air arm: the two sortie clocks, the gunships and the bombs in the air.
 *
 * Appended after the replacement clocks for the same reason those were appended
 * after the units - every offset above this line stays where it was, so a change
 * of layout is never also a silent change of meaning for a field that did not
 * move. The hashes move regardless; bombs kill people.
 *
 * The clocks are state, not locals, for the reason the replacement clocks are:
 * a verifier replaying a transcript has to arrive at the same bytes, and a
 * timer outside the buffer is a timer two implementations can disagree about
 * without either one noticing. In the C# they are worse than locals - they are
 * on UnityEngine.Random, so the air war cannot be replayed from a seed at all.
 */
export const O_AIR = O_ARMY + A_WORDS;
export const AIR_BULL = 0, AIR_BEAR = 1;
export const AIR_WORDS = 2;

/**
 * Gunship slots. Two a side, and one a side is what the arithmetic allows.
 *
 * A sortie's transit is the full 208 m corridor at 20 m/s - 10.4 s - and the
 * shortest gap the jitter can produce is 17 * 0.7 = 11.9 s, so a side's next
 * gunship cannot enter before the last one has left. Two a side is the margin,
 * and rules.test.js pins the invariant by watching the airborne count rather
 * than trusting the arithmetic: if a launch ever found every slot busy the
 * sortie would be dropped in silence, which is exactly the kind of quiet
 * divergence this core exists to make impossible.
 *
 * Yaw and bank are not here. They are how a mesh tilts; nothing downstream
 * reads them. Height IS here - it decides how long a bomb falls and therefore
 * how far the 30 m/s along the track throws it, which is a third of the load
 * landing off the field.
 */
export const O_HELIS = O_AIR + AIR_WORDS;
export const MAX_HELIS = 4;
export const H_WORDS = 8;
export const H_STATE = 0, H_SIDE = 1, H_X = 2, H_Y = 3, H_Z = 4;
export const H_DIR = 5, H_T = 6, H_DROPIN = 7;

/**
 * Bombs in the air. A gunship drops every 1.6-3.2 s and a bomb falls for about
 * two, so two per gunship is the ceiling and four gunships cannot fill eight.
 */
export const O_BOMBS = O_HELIS + Math.imul(MAX_HELIS, H_WORDS);
export const MAX_BOMBS = 8;
export const B_WORDS = 8;
export const B_STATE = 0, B_SIDE = 1, B_X = 2, B_Y = 3, B_Z = 4;
export const B_VX = 5, B_VY = 6, B_VZ = 7;

export const WORDS = O_BOMBS + Math.imul(MAX_BOMBS, B_WORDS);

// truck fields, relative to O_TRUCK
export const T_X = 0, T_Z = 1, T_HEADING = 2, T_VX = 3, T_VZ = 4;
export const T_ANGVEL = 5, T_HP = 6, T_CARGO = 7, T_FLAGS = 8;
export const T_WHEEL = 9, T_THROTTLE = 10, T_STEER = 11;

/**
 * Closing speed of the last armour impact, in m/s, or zero.
 *
 * Written by the collision and cleared once read. PhysX used to raise
 * OnCollisionEnter for this and the body is kinematic now, so nothing fires -
 * which is why a truck could be driven into a tank and come away unmarked.
 */
export const T_IMPACT = 12;

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
export const heliBase = (i) => O_HELIS + Math.imul(i, H_WORDS);
export const bombBase = (i) => O_BOMBS + Math.imul(i, B_WORDS);

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
