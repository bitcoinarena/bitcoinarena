// The run score, from section 18A of the specification.
//
//   score = 1000 * E * T * C
//
// All three multiplicative, so any one at zero collapses the total. That is
// the whole point: an additive score lets a fast, full, safe run out-score a
// slow, damaged, brave one, which is the inversion the section exists to
// prevent.

import { ONE, add, sub, mulFast, mulRound, mulDivRound, toIntRound, div, divRound, clamp, min, max, abs, length2 } from '../fixed.js';

/** Metres of ground made good at full danger for E = 1. */
export const EXPOSURE_REFERENCE = Math.imul(190, ONE);
/** Par time in ticks, at 60 Hz. */
export const REFERENCE_TICKS = 3900;
/** No danger is earned within this of the start. */
export const APRON_RADIUS = Math.imul(22, ONE);

export const T_FLOOR = 16384;      // 0.25
export const T_CEIL = 98304;       // 1.5

// The time clamp, said in ticks: T = REFERENCE_TICKS / ticks held to
// [0.25, 1.5] is exactly ticks held to [2600, 15600]. Written out so the two
// forms cannot drift apart silently.
export const T_TICKS_MIN = 2600;   // REFERENCE_TICKS / 1.5
export const T_TICKS_MAX = 15600;  // REFERENCE_TICKS / 0.25

/**
 * Accumulates exposure over GROUND MADE GOOD against a high-water mark.
 *
 * As a time integral this paid for presence: parked on the seam a loaded truck
 * scored for standing still, and once through the fighting a player could
 * circle and keep earning - dawdling roughly tripled E while T, floored at
 * 0.5, only halved. Against a high-water mark a lap covers no new ground and
 * earns exactly nothing, while the round clock runs on regardless.
 *
 * Returns the new exposure accumulator; the caller keeps the mark.
 */
export function accrue(exposure, bestX, x, threat, heat) {
  if (x <= bestX) return exposure;
  const gained = sub(x, bestX);
  const rate = mulFast(threat, add(ONE, heat));
  return add(exposure, mulFast(rate, gained));
}

export const exposureFactor = (exposure) =>
  clamp(divRound(exposure, EXPOSURE_REFERENCE), 0, ONE);

export const timeFactor = (ticks) =>
  ticks <= 0 ? T_CEIL
             : clamp(divRound(Math.imul(REFERENCE_TICKS, ONE), Math.imul(ticks, ONE)),
                     T_FLOOR, T_CEIL);

/**
 * The score itself, in whole points.
 *
 * `cargo` is bed fill in Q16.16. Returned as an integer because a score is
 * counted, not measured, and because a fractional score would be one more
 * thing two implementations could round differently.
 */
export function scoreOf(exposure, ticks, cargo) {
  // NO FACTOR IS EVER FORMED ON ITS OWN. `exposureFactor` and `timeFactor`
  // below are the readable statement of the rule and stay the tested ones, but
  // each returns a fraction of at most 1.0 in Q16.16, quantised to 1.5e-5 -
  // and this score multiplies by a thousand, which scales that error to 0.015
  // points. Carrying the thousand from the first step instead, and rounding
  // only at the end of each divide, leaves a grid of 1/65536 of a point.
  //
  // Both clamps survive the move. Exposure is clamped to the reference before
  // dividing, which is the same as clamping the ratio at 1. Time is clamped on
  // the TICKS, not the factor: T is 3900/ticks held to [0.25, 1.5], so ticks
  // held to [2600, 15600] says the identical thing exactly, and it also gives
  // an instant run its 1.5 without a separate branch.
  //
  // Magnitudes, since `mulDivRound` is only exact under 2^53: the largest
  // intermediate is 1000 ONE * 190 ONE = 8.2e14, and no result passes 1500 ONE.
  const ex = clamp(exposure, 0, EXPOSURE_REFERENCE);
  const tk = clamp(ticks | 0, T_TICKS_MIN, T_TICKS_MAX);
  const c = clamp(cargo, 0, ONE);
  const scaled = mulDivRound(Math.imul(1000, ONE), ex, EXPOSURE_REFERENCE);
  return toIntRound(mulRound(mulDivRound(scaled, REFERENCE_TICKS, tk), c));
}

/**
 * Whether a spot earns anything at all: outside the apron, and gaining ground.
 *
 * Takes the two components rather than a distance, because the distance is
 * exactly the thing that cannot be trusted here. `length2` squares its
 * arguments in Q16.16, so a separation past about 181.5 m wraps the sum of
 * squares past 2^31 and comes back as ZERO - and this map runs 260 m across
 * with its start on the apron at x = -100.4, so a truck beyond x = 80.4 read
 * as standing ON its start and stopped earning. Measured before the guard: the
 * last 33.5 m of ground it gained was never paid for, and that is the run-in,
 * where the danger is highest.
 *
 * The rejection runs the OPPOSITE way to the ones in army.js and solids.js.
 * Those ask whether a point is INSIDE a radius, where a large axis rules the
 * answer out; this asks whether it is OUTSIDE one, where a large axis PROVES
 * it. Copying their shape unchanged would have kept the bug.
 */
export const earning = (dx, dz, gainingGround) =>
  gainingGround &&
  (abs(dx) > APRON_RADIUS || abs(dz) > APRON_RADIUS || length2(dx, dz) >= APRON_RADIUS);
