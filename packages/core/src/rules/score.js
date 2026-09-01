// The run score, from section 18A of the specification.
//
//   score = 1000 * E * T * C
//
// All three multiplicative, so any one at zero collapses the total. That is
// the whole point: an additive score lets a fast, full, safe run out-score a
// slow, damaged, brave one, which is the inversion the section exists to
// prevent.

import { ONE, add, sub, mulFast, div, clamp, min, max } from '../fixed.js';

/** Metres of ground made good at full danger for E = 1. */
export const EXPOSURE_REFERENCE = Math.imul(190, ONE);
/** Par time in ticks, at 60 Hz. */
export const REFERENCE_TICKS = 3900;
/** No danger is earned within this of the start. */
export const APRON_RADIUS = Math.imul(22, ONE);

export const T_FLOOR = 16384;      // 0.25
export const T_CEIL = 98304;       // 1.5

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
  clamp(div(exposure, EXPOSURE_REFERENCE), 0, ONE);

export const timeFactor = (ticks) =>
  ticks <= 0 ? T_CEIL
             : clamp(div(Math.imul(REFERENCE_TICKS, ONE), Math.imul(ticks, ONE)),
                     T_FLOOR, T_CEIL);

/**
 * The score itself, in whole points.
 *
 * `cargo` is bed fill in Q16.16. Returned as an integer because a score is
 * counted, not measured, and because a fractional score would be one more
 * thing two implementations could round differently.
 */
export function score(exposure, ticks, cargo) {
  const e = exposureFactor(exposure);
  const t = timeFactor(ticks);
  const c = clamp(cargo, 0, ONE);
  const product = mulFast(mulFast(e, t), c);
  return mulFast(Math.imul(1000, ONE), product) >> 16;
}

/** Whether a spot earns anything at all: outside the apron, and gaining ground. */
export const earning = (distanceFromStart, gainingGround) =>
  distanceFromStart >= APRON_RADIUS && gainingGround;
