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
// WHAT A FULL RUN OF RISK IS WORTH, and it was set too low to tell two runs
// apart. the owner drove the seam and drove the edges and both paid about a
// thousand.
//
// Exposure accrues as `threat * (1 + cargo) * forward metres`, and a run gains
// about 180 m of x with a full bed doubling the multiplier - so a reference of
// 190 was reached at an AVERAGE THREAT OF 0.53. The threat map itself is well
// shaped, measured across the field: 0.00 at the corners, 1.00 at the seam.
// Everything from half-dangerous upwards clamped to 1.0 and scored the same.
//
// 320 is the integral of the most dangerous run actually available - 180 m at
// an average threat of about 0.9, doubled for cargo - so the ceiling is now
// where the bravest line is rather than half way up. The edges, averaging
// about 0.1, come out near 36: a ninth of the seam instead of the same score.
export const EXPOSURE_REFERENCE = Math.imul(320, ONE);
/**
 * PAR TIME, IN TICKS, AND THE TICKS ARE THE RULE.
 *
 * the owner 2026-10-04 09:17: T starts to sink at 20 seconds. The ceiling stays
 * 1.5 and the floor stays 0.25. 20 s is 1200 ticks (1200 x 1092/65536 =
 * 19.995 s). T leaves 1.5 there, is 1 at 1800 ticks (30 s), and reaches 0.25
 * at 7200 ticks (120 s). The old par was 3900 ticks, about 65 s.
 *
 * A tick count is what the simulation compares against, so this IS the par.
 * The tick is 1092/65536 s and not a sixtieth (`tick.js`).
 */
export const REFERENCE_TICKS = 1800;
/** No danger is earned within this of the start. */
export const APRON_RADIUS = Math.imul(22, ONE);

/** Metres off the seam at which a metre of ground pays nothing.
 *  36, not 40: a 10% tighter band so a lane that skirts the front pays nothing
 *  sooner (the owner 2026-09-23). */
export const FRONT_SCORE_SPAN = Math.imul(36, ONE);

/**
 * How much of the local threat counts for the score, from distance to the
 * front. 1 on the seam, 0 at 36 m and beyond. Quadratic so a rim far from
 * the fighting is not a slightly quieter lane (the owner 2026-09-07).
 */
export const frontWeight = (z, seam) => {
  const sep = abs(sub(z, seam));
  if (sep >= FRONT_SCORE_SPAN) return 0;
  const t = sub(ONE, div(sep, FRONT_SCORE_SPAN));
  return mulFast(t, t);
};

export const T_FLOOR = 16384;      // 0.25
export const T_CEIL = 98304;       // 1.5

// The time clamp, said in ticks: T = REFERENCE_TICKS / ticks held to
// [0.25, 1.5] is exactly ticks held to [1200, 7200]. Written out so the two
// forms cannot drift apart silently. 1200 ticks is 20 seconds: T starts to sink.
export const T_TICKS_MIN = 1200;   // REFERENCE_TICKS / 1.5, 20 s
export const T_TICKS_MAX = 7200;   // REFERENCE_TICKS / 0.25, 120 s

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
 * THE FACTORS ON THE GRID THE CARD PRINTS, AND THE SCORE THEIR PRODUCT (the owner 2026-09-25: "Their product is the score,
 * so the core's score is that product"; multiplayer_p2p.md §18A.3: score = 1000 · E · T · C).
 *
 * Each factor is an integer count of 1e-5 (FACTOR_SCALE), formed from the core's own word and rounded once, half up:
 *   E5 = S_EXPOSURE held to the 320 m reference, over that reference     0 .. 100000
 *   T5 = 1800 over S_ELAPSED held to 1200 .. 7200 ticks                  25000 .. 150000
 *   C5 = S_CARGO held to 0 .. ONE, over ONE                              0 .. 100000
 * and the score is 1000 · E · T · C of those, kept as an integer count of 1e-5 points (SCORE_SCALE): E5·T5·C5 / 1e7,
 * rounded once, half up. So the product of the factors as the card prints them, to five decimals, IS the score to five
 * decimals - one number, not a product beside a rounded one.
 *
 * WHAT MOVED, AND WHY: this returned whole points - 1000·E·T·C carried in Q16.16 and rounded to an integer at the end -
 * so a run whose exact product was 7.49984 scored 7 while its factors, printed to five decimals (E 0.02500, T 1.50000,
 * C 0.20000), multiplied to 7.50000: two numbers for one score. The factors now live on the printed grid and the score
 * is their product; nothing is floored or rounded to a whole point.
 *
 * Exact in JS numbers: E5·T5·C5 <= 1e5 · 1.5e5 · 1e5 = 1.5e15 < 2^53, and every quotient is an integer division of
 * integers under 2^53 whose fractional parts are at least 1/D apart - far wider than the division's own rounding.
 * A score of 1500 points is 150000000 in these units, well inside the i32 word and the result's u32.
 */
export const FACTOR_SCALE = 100000;
export const SCORE_SCALE = 100000;
const divRoundInt = (n, d) => Math.floor((2 * n + d) / (2 * d));
export const exposure5 = (exposure) => divRoundInt(clamp(exposure, 0, EXPOSURE_REFERENCE) * FACTOR_SCALE, EXPOSURE_REFERENCE);
export const time5 = (ticks) => divRoundInt(REFERENCE_TICKS * FACTOR_SCALE, clamp(ticks | 0, T_TICKS_MIN, T_TICKS_MAX));
export const cargo5 = (cargo) => divRoundInt(clamp(cargo, 0, ONE) * FACTOR_SCALE, ONE);

export function scoreOf(exposure, ticks, cargo) {
  return divRoundInt(exposure5(exposure) * time5(ticks) * cargo5(cargo), 10000000);
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
