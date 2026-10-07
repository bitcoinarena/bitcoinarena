// The mempool relief, ported from MempoolTerrain.HeightAt.
//
// Height comes from the fee histogram - a busy chain is a mountainous map -
// plus a noise field so the ground is not a staircase of flat bands, plus an
// apron levelled at BOTH ends where the two buildings stand.

import { ONE, add, sub, mulFast, div, clamp, min, max } from '../fixed.js';
import { noise2 } from './noise.js';

export const COLUMNS = 128;
const FEE_HEIGHT = Math.imul(9, ONE);
const BASE_RELIEF = 360448;          // 5.5 in Q16.16
const SUB_SAT = 655;                 // 0.01
const APRON = 14418;                 // 0.22 of the width, in Q16.16

/**
 * log10(1 + fee), Q16.16 in and out, by table-free integer means.
 *
 * The C# uses Mathf.Log10 to keep a 400 sat/vB spike from dwarfing the map.
 * Here it is a binary logarithm from the bit length plus a linear fraction,
 * scaled to base ten - accurate to about half a percent, which is far inside
 * what a hillside needs.
 */
export function log10p1(x) {
  let v = add(x, ONE);
  if (v <= ONE) return 0;
  let e = 0, t = v;
  while (t >= (ONE << 1)) { t >>= 1; e++; }        // t now in [1, 2)
  const frac = sub(t, ONE);                         // Q16.16 in [0, 1)
  const log2 = add(Math.imul(e, ONE), frac);        // crude but monotone
  return mulFast(log2, 19728);                      // 1/log2(10) = 0.30103
}

/**
 * Surface height at a normalised position. `u` and `v` are Q16.16 in [0, 1),
 * `profile` is an Int32Array of COLUMNS fee rates in Q16.16.
 */
export function heightAt(profile, u, v, seed) {
  const c = clamp((mulFast(u, Math.imul(COLUMNS - 1, ONE)) + 32768) >> 16, 0, COLUMNS - 1);
  const fee = max(profile[c], SUB_SAT);
  let h = mulFast(log10p1(fee), FEE_HEIGHT);

  h = add(h, mulFast(noise2(mulFast(u, Math.imul(7, ONE)),
                            mulFast(v, Math.imul(5, ONE)), seed), BASE_RELIEF));

  // Aprons. Both ends are levelled to the height of their own outer column,
  // eased in, because the miner and the post office stand there and their
  // doors are metres wide - relief climbing through them puts a delivery yard
  // on a hillside.
  const into = ramp(sub(ONE, APRON), ONE, u);
  if (into > 0) {
    const flat = mulFast(log10p1(max(profile[COLUMNS - 1], SUB_SAT)), FEE_HEIGHT);
    h = lerp(h, flat, smoothstep(into));
  }
  const outOf = ramp(APRON, 0, u);
  if (outOf > 0) {
    const flat = mulFast(log10p1(max(profile[0], SUB_SAT)), FEE_HEIGHT);
    h = lerp(h, flat, smoothstep(outOf));
  }
  return h;
}

const lerp = (a, b, t) => add(a, mulFast(sub(b, a), t));
const smoothstep = (t) => {
  const t2 = mulFast(t, t);
  return (Math.imul(3, t2) - Math.imul(2, mulFast(t2, t))) | 0;
};
/** InverseLerp, clamped to [0, 1]. */
function ramp(from, to, x) {
  const span = sub(to, from);
  if (span === 0) return 0;
  return clamp(div(sub(x, from), span), 0, ONE);
}
