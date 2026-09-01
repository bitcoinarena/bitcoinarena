// Where the two armies meet, ported from PriceHistory.FrontlineZ.
//
// The seam is the price tape laid across the map: the oldest sample sits at the
// far -x end, the newest at +x, and the line's z is how far the price has moved
// from the window's midpoint. A rising market pushes the bulls forward.

import { ONE, add, sub, mulFast, div, clamp, min, max } from '../fixed.js';

export const SAMPLES = 64;

/**
 * Frontline z at a world x. `hist` is an Int32Array of SAMPLES prices in
 * Q16.16 (scaled however the caller likes - only ratios matter), `halfX` and
 * `halfZ` are the map's half extents in Q16.16.
 */
export function frontlineZ(hist, x, halfX, halfZ) {
  if (SAMPLES < 2) return 0;

  // position along the tape, 0 at -halfX, ONE at +halfX
  const u = clamp(div(add(x, halfX), Math.imul(2, halfX)), 0, ONE);
  const at = mulFast(u, Math.imul(SAMPLES - 1, ONE));
  const i = clamp(at >> 16, 0, SAMPLES - 2);
  const f = at & 65535;

  const a = hist[i], b = hist[i + 1];
  const price = add(a, mulFast(sub(b, a), f));

  // the window's own range decides the scale, so a quiet market still moves
  let lo = hist[0], hi = hist[0];
  for (let k = 1; k < SAMPLES; k++) { lo = min(lo, hist[k]); hi = max(hi, hist[k]); }
  const span = sub(hi, lo);
  if (span <= 0) return 0;

  // -1 .. +1 about the midpoint, then two thirds of the map's half depth
  const t = sub(div(mulFast(sub(price, lo), Math.imul(2, ONE)), span), ONE);
  return mulFast(t, mulFast(halfZ, 43690));
}
