// Where the two armies meet, ported from PriceHistory.FrontlineZ.
//
// The seam is the price tape laid across the map: the oldest sample sits at the
// far -x end, the newest at +x, and the line's z is how far the price has moved
// from the window's midpoint. A rising market pushes the bulls forward.

import { ONE, add, sub, mulFast, div, divRound, clamp, min, max } from '../fixed.js';

export const SAMPLES = 64;

/**
 * The seam's reach either side of z = 0 as a share of the half depth, Q16.16: 0.53, +-45 m (WAR_TACTICS.md §4.15, the owner
 * 2026-09-17 09:40: a smaller static chart, so the relief outside the band stands behind the lines). It was 0.72 (C#'s
 * +-61.2 m, see `frontlineZ`); 0.53 x 65536 = 34734.08.
 */
export const FRONT_DEPTH = 34734;

/**
 * THE CHART'S X (WAR_TACTICS.md §4.15, seam remap ruled 2026-09-17): the tape is laid over the candle field, not the old
 * +-130 m map, so the fight line's price at an x is read from the samples of the candle standing at that x. 32 slots of
 * FIELD_SLOT from FIELD_X0 (spawn ruling B: first face 26 m past the spawn centre, last slot ending before the miner face);
 *
 * RULING B REFITTED TO THE MEASURED DOOR (the owner 2026-09-19 13:09 and his pick after the measurement). The "miner face"
 * the ruling named is x 108.4, which is where the MODEL'S ORIGIN is placed - not where the building begins. Measured
 * out of bitcoin_miner_megastructure.glb, through DeliveryGate's 180-degree turn and (1, 0.45, 1) scale, the miner
 * stands on the ground from x 53.8 m (power cables), with feet at 62.8, legs at 66.9 and its lower mass from 64.4;
 * its entry corridor, |z| <= 34 m, is clear of all of that from x 90.4 m east. So the old fit put the last nine
 * slots and 24 m of road INSIDE the building (miner-entrance-covered-1309.jpg). The same fit, done against the
 * measured door instead of the origin: the same 32 slots, the same west end, pitch 5.75624 -> 5.18124 m, the last
 * slot ending at 89.99983 m. The miner does not move and the map's edges do not move. MINER_DOOR_X in map.js is the
 * door itself, and the road ribbon ends there too - Unity draws what the core says.
 * slot k holds the round's candle whose samples are tape k*2 + (taken & 1) and the next, so its centre is that pair's middle.
 * Measured before: at a candle's centre the seam read the tape up to 9.7 samples away, and HUD YOU sat on the wrong candle
 * for 28-29 of 32.
 */
export const FIELD_X0 = -4967627;                  // -75.79998 m
export const FIELD_SLOT = 339558;                  // 5.18124 m; 32 slots end at 89.99983 m, at the miner's door
const TAPE_HALF = 32768, TAPE_LAST_Q = Math.imul(SAMPLES - 1, ONE);

/**
 * THE SCROLL (§4.15 movement, the owner 2026-09-17 13:49), in samples, Q16.16: how far the chart has slid toward the post
 * office since its slots last lined up. One sample is half a slot (2.878 m at the spawn-B pitch) over the 300 ticks a
 * sample lasts, 0.576 m/s; held at a whole sample when the next one is late. The pairing moves a candle one whole slot
 * every second sample, so the slide runs 0..2 samples between those moves - `(1 - taken & 1)` whole samples plus the
 * fraction - and every sample tick lands exactly where the slide had got to: no jump.
 */
export function scrollOf(taken, tick, sampleTick) {
  const frac = clamp(div(sub(tick, sampleTick), 300), 0, ONE);      // ticks are whole: (tick - sampleTick) / 300 in Q16
  return add(Math.imul(1 - (taken & 1), ONE), frac);
}

/** The tape position (Q16.16 samples, unclamped) a world x reads, with `taken` samples submitted and the chart `scroll`ed. */
export function tapeAtX(x, taken, scroll = 0) {
  return add(add(add(Math.imul(taken & 1, ONE), Math.imul(divRound(sub(x, FIELD_X0), FIELD_SLOT), 2)), -TAPE_HALF), scroll);
}

/** The world x of a tape position (Q16.16 samples): the inverse of `tapeAtX`. */
export function xAtTape(q, taken, scroll = 0) {
  return add(FIELD_X0, mulFast(sub(add(sub(q, scroll), TAPE_HALF), Math.imul(taken & 1, ONE)) >> 1, FIELD_SLOT));
}

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

function smooth(hist, j, older) {
  let sum = 0;
  for (let k = j - HALFW; k <= j + HALFW; k++) {
    // west of the tape: the sample that left it last, fading into the oldest (§4.15 glide); east: the newest, held
    sum += k < 0 ? older : hist[k > SAMPLES - 1 ? SAMPLES - 1 : k];
  }
  // `div`, not a bare `/`: the determinism guard allows the operator only
  // inside the arithmetic file, and it is right to. Exact here with room to
  // spare - the largest tape value measured over three seeds and a minute is
  // 20,099,840, so `sum * ONE` peaks at 2.77e13 against the 9.01e15 where a
  // double stops counting integers, a factor of 325.
  return div(sum, Math.imul(WINDOW, ONE));
}

export function frontlineZ(hist, x, halfX, halfZ, taken = 0, scroll = 0, scaleLo = null, scaleHi = null, older = hist[0]) {
  if (SAMPLES < 2) return 0;

  // position along the tape over the candle field (tapeAtX), held at the tape's ends beyond it
  // Not clamped to the tape (§4.15 "nothing jumps"): a position clamped at an end reads a fixed tape index while the tape
  // moves under it - 3.6 m at x 102 on every sample. Past the ends `smooth` holds the edges, flat by HALFW + 1 samples out.
  const at = clamp(tapeAtX(x, taken, scroll), Math.imul(-HALFW - 1, ONE), Math.imul(SAMPLES + HALFW, ONE));
  const i = at >> 16;
  const f = at & 65535;

  const a = smooth(hist, i, older), b = smooth(hist, i + 1, older);
  const price = add(a, mulFast(sub(b, a), f));

  // the window's own range decides the scale, so a quiet market still moves
  let lo = hist[0], hi = hist[0];
  for (let k = 1; k < SAMPLES; k++) { lo = min(lo, hist[k]); hi = max(hi, hist[k]); }
  if (scaleLo !== null) { lo = scaleLo; hi = scaleHi; }   // the window lerped over the sample (§4.15 rescale)
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
  return mulFast(t, mulFast(halfZ, FRONT_DEPTH));
}
