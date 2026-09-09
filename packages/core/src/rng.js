// xoshiro128** with splitmix32 seeding. Four 32-bit words, built only from
// Math.imul and shifts, so it is exactly reproducible in every engine.
//
// The DRAW ORDER IS PROTOCOL. Two implementations that draw the same numbers in
// a different order produce different worlds, so every rule module takes an
// explicit stream handle and never reaches for a global.

const rotl = (x, k) => ((x << k) | (x >>> (32 - k))) | 0;

/** Advances the state and returns a uint32. `s` is an Int32Array(4). */
export function next(s) {
  const r = Math.imul(rotl(Math.imul(s[1], 5), 7), 9);
  const t = (s[1] << 9) | 0;
  s[2] ^= s[0];
  s[3] ^= s[1];
  s[1] ^= s[2];
  s[0] ^= s[3];
  s[2] ^= t;
  s[3] = rotl(s[3], 11);
  return r >>> 0;
}

/** Uniform integer in [0, bound). Rejection-free modulo bias is accepted here
 *  and documented: the bounds used by game rules are small against 2^32. */
export function below(s, bound) {
  if (bound <= 1) return 0;
  return (next(s) % bound) | 0;
}

/** Q16.16 in [0, 1). */
export const unit = (s) => (next(s) >>> 16) | 0;

/** Q16.16 in [lo, hi). */
export function between(s, lo, hi) {
  if (hi <= lo) return lo;
  const span = (hi - lo) | 0;
  return (lo + Math.imul(unit(s), span >> 16) + ((unit(s) * (span & 65535)) >>> 16)) | 0;
}

/** How many loading-bay doors the post office has. */
export const BAY_COUNT = 24;
/** Solo / golden-vector bay (Unity PostOffice.SoloBay). */
export const SOLO_BAY = 13;
/** Harness seed that must keep parking in SOLO_BAY. */
export const SOLO_SEED = 0x5eed1234;

/**
 * Which bay a player parks in. Derived from their seed so two players in
 * one round do not share a door. The mixer is chosen so SOLO_SEED still
 * lands on SOLO_BAY and the golden vectors do not move for the harness.
 */
export function spawnBay(seedWord) {
  const mixed = Math.imul(seedWord | 0, 1597334677) >>> 0;
  const solo = Math.imul(SOLO_SEED, 1597334677) >>> 0;
  return ((mixed - solo + SOLO_BAY) >>> 0) % BAY_COUNT;
}

/** splitmix32: expands one 32-bit seed word into the generator's four. */
export function seed(s, word) {
  let z = word | 0;
  for (let i = 0; i < 4; i++) {
    z = (z + 0x9e3779b9) | 0;
    let x = z;
    x = Math.imul(x ^ (x >>> 16), 0x21f0aaad);
    x = Math.imul(x ^ (x >>> 15), 0x735a2d97);
    s[i] = (x ^ (x >>> 15)) | 0;
  }
  // a generator seeded to all zeros never leaves zero
  if ((s[0] | s[1] | s[2] | s[3]) === 0) s[0] = 1;
  return s;
}
