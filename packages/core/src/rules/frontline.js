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
/**
 * The tape, box-averaged over WINDOW samples, edges held.
 *
 * WHY THERE IS A FILTER HERE AT ALL. The tape is a price series and the raw
 * function laid it across the map at one sample every 4.13 m, so the "front"
 * was a price chart, not a line: measured across the map it ran +29.1, +2.6,
 * +37.6, +5.8, +28.1, -8.6, +8.8, -40.5, -28.4 at 22 m steps. A man walking
 * nine metres sideways saw his goal move sixty. Chasing it, nobody ever
 * arrived - infantry sat 36.5 m behind a line whose own standoff is 8.
 *
 * THE WIDTH IS DERIVED, NOT PICKED. A rifleman closes in z at 3.4 m/s and
 * moves in x at 2.4 m/s (`Army.cs:681`), so a goal that slides more than
 * 3.4/2.4 = 1.42 metres per metre of x runs away faster than he can walk.
 * Measured over five tapes, the raw slope is 6.00 mean and 14.21 at the 99th
 * percentile, with 88% of the map above the limit. Box-averaged:
 *
 *     N     mean   p99    max   over the limit   amplitude
 *      1    6.00  14.21  14.35      88.0%        +-56.7 m
 *      9    0.93   2.66   2.80      22.9%        +-38.5 m
 *     13    0.56   1.80   1.93       3.7%        +-42.7 m
 *     21    0.42   1.20   1.27       0.0%        +-39.5 m
 *
 * 21 is the first width where the 99th percentile AND the maximum are both
 * under 1.42 and no part of the map is above it. Wider only costs amplitude:
 * the front must still move with the market, and at 21 it still swings
 * +-39.5 m across the map.
 *
 * The normalisation below deliberately keeps the RAW window's low and high,
 * not the smoothed one's. Renormalising against the smoothed range would
 * re-expand the filtered curve to full scale and put the slope back: measured,
 * that variant still leaves 9.9% of the map over the limit at N=21.
 *
 * C# has no filter. This is not a port of `PriceHistory.FrontlineZ` losing a
 * term - it is the core refusing to copy a fault: a quantity used as a FRONT
 * LINE cannot have 4 m resolution and 60 m steps, whatever it was called
 * upstream.
 */
const WINDOW = 21;
const HALFW = 10;

function smooth(hist, j) {
  let sum = 0;
  for (let k = j - HALFW; k <= j + HALFW; k++) {
    const q = k < 0 ? 0 : (k > SAMPLES - 1 ? SAMPLES - 1 : k);
    sum += hist[q];
  }
  // `div`, not a bare `/`: the determinism guard allows the operator only
  // inside the arithmetic file, and it is right to. Exact here with room to
  // spare - the largest tape value measured over three seeds and a minute is
  // 20,099,840, so `sum * ONE` peaks at 2.77e13 against the 9.01e15 where a
  // double stops counting integers, a factor of 325.
  return div(sum, Math.imul(WINDOW, ONE));
}

export function frontlineZ(hist, x, halfX, halfZ) {
  if (SAMPLES < 2) return 0;

  // position along the tape, 0 at -halfX, ONE at +halfX
  const u = clamp(div(add(x, halfX), Math.imul(2, halfX)), 0, ONE);
  const at = mulFast(u, Math.imul(SAMPLES - 1, ONE));
  const i = clamp(at >> 16, 0, SAMPLES - 2);
  const f = at & 65535;

  const a = smooth(hist, i), b = smooth(hist, i + 1);
  const price = add(a, mulFast(sub(b, a), f));

  // the window's own range decides the scale, so a quiet market still moves
  let lo = hist[0], hi = hist[0];
  for (let k = 1; k < SAMPLES; k++) { lo = min(lo, hist[k]); hi = max(hi, hist[k]); }
  const span = sub(hi, lo);
  if (span <= 0) return 0;

  // -1 .. +1 about the midpoint, then C#'s own share of the map's half depth.
  //
  // 43690 stood here - two thirds - and `PriceHistory.FrontlineZ:128` returns
  // `(n - 0.5) * worldDepth * 0.72`. With `n` in [0, 1] that is +-0.36 of the
  // FULL depth, and `MempoolTerrain` has width 260 and depth 170, which are
  // exactly twice the core's HALF_X 130 and HALF_Z 85. So C#'s amplitude is
  // 0.72 of the HALF depth and the core's was 0.6667 of it: the same quantity
  // in the same units, off by 8%, and +-56.7 m where C# has +-61.2 m.
  //
  // That 3.1 m of amplitude is depth C# MEANS, not tape noise, so it comes
  // back. The other 18.8 m of the gap to C# is the jag this file filters out
  // on purpose - 86% of the difference - and it stays out: a front a man
  // cannot close on is not a front, whatever its amplitude.
  //
  // It changes no envelope quantity. Both verdicts are measured under
  // `--seam0`, where the tape is flat, `span` is zero and this function
  // returns 0 before it ever reaches the scale - 68/72 air off and 65/72 air
  // on, identical to the digit with either constant. This is a wrong number
  // made right, not a number tuned to a test.
  const t = sub(div(mulFast(sub(price, lo), Math.imul(2, ONE)), span), ONE);
  return mulFast(t, mulFast(halfZ, 47186));
}
