// Value noise on integers.
//
// The C# terrain uses Mathf.PerlinNoise, which is Unity's own implementation
// and not reproducible anywhere else - not in another engine, not in another
// Unity version. The relief only needs to be *a* stable pseudo-random field,
// not Unity's specific one, so this replaces it: an integer hash at the
// lattice points and smoothstep between them.
//
// The consequence is honest and worth stating: terrain built by this core will
// not look identical to today's Unity build. It will look like the same kind
// of landscape.

import { ONE, mulFast, sub } from '../fixed.js';

/** 32-bit integer hash of a lattice point. Returns Q16.16 in [0, 1). */
function lattice(x, y, seed) {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ seed;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return (h ^ (h >>> 15)) >>> 16;
}

/** Smoothstep in Q16.16: 3t^2 - 2t^3. */
function smooth(t) {
  const t2 = mulFast(t, t);
  const t3 = mulFast(t2, t);
  return (Math.imul(3, t2) - Math.imul(2, t3)) | 0;
}

/**
 * Value noise at a Q16.16 coordinate. Returns Q16.16 in [0, 1).
 *
 * One octave: the relief it feeds is already shaped by the fee profile, and a
 * second octave would cost a tick's worth of budget for detail nobody driving
 * at 25 m/s can see.
 */
export function noise2(x, y, seed) {
  const xi = x >> 16, yi = y >> 16;
  const xf = x & 65535, yf = y & 65535;
  const u = smooth(xf), v = smooth(yf);

  const a = lattice(xi, yi, seed);
  const b = lattice(xi + 1, yi, seed);
  const c = lattice(xi, yi + 1, seed);
  const d = lattice(xi + 1, yi + 1, seed);

  const top = (a + mulFast(sub(b, a), u)) | 0;
  const bot = (c + mulFast(sub(d, c), u)) | 0;
  return (top + mulFast(sub(bot, top), v)) | 0;
}
