// Q16.16 fixed point. THE ONLY FILE that may use * and / directly, and the
// determinism guard enforces that (tools/check-determinism.js).
//
// One unit is 1/65536. The range is +/-32768, which covers a 260 x 170 m map,
// velocities, angles and health with room to spare.
//
// Every operation here produces an exact integer result, so it is identical in
// every conforming engine: ECMAScript specifies integer arithmetic on Numbers
// exactly as long as operands and results are integers below 2^53, and
// specifies the bitwise operators as 32-bit with defined wrapping.

export const SHIFT = 16;
export const ONE = 65536;
export const HALF = 32768;

export const fromInt = (n) => (n << SHIFT) | 0;
export const toInt = (x) => x >> SHIFT;            // arithmetic shift = floor

/** Only for constants in source. Never call this on runtime data. */
export const fromFloat = (f) => Math.round(f * ONE) | 0;

export const add = (a, b) => (a + b) | 0;
export const sub = (a, b) => (a - b) | 0;
export const neg = (a) => (-a) | 0;
export const abs = (a) => (a < 0 ? (-a) | 0 : a);

/**
 * Fast multiply. Exact while |a*b| < 2^53, which holds for any pair of Q16.16
 * values whose product stays inside the representable range - the intermediate
 * is at most 2^31 * 2^31 = 2^62, so this is NOT universally safe and the caller
 * must know its magnitudes. Used on the simulation's hot paths.
 */
export const mulFast = (a, b) => ((a * b) / ONE) | 0;

/**
 * Rounding multiply, and rounding conversion back to a whole number. `mulFast`
 * and `toInt` both throw the fraction away, which is right for the simulation -
 * a truncation there is a rule, applied identically on every engine - but wrong
 * where the value being produced is a *reported* number that some other
 * implementation rounds. The score is the one such number: the old game ends on
 * `Mathf.RoundToInt`, so the core has to round too or it sits a point low on
 * roughly half of all runs. Same magnitude rules as `mulFast`: the caller must
 * know |a*b| stays under 2^53.
 */
export const mulRound = (a, b) => (((a * b) + (ONE >> 1)) / ONE) | 0;
export const toIntRound = (x) => (x + (ONE >> 1)) >> SHIFT;

/**
 * Exact multiply for anything that could overflow the double's integer range.
 * BigInt is exact at any width; it allocates, so it stays off per-unit inner
 * loops by convention rather than by enforcement.
 */
export const mulWide = (a, b) =>
  Number((BigInt(a) * BigInt(b)) >> BigInt(SHIFT)) | 0;

/** Truncating divide. Returns 0 for a zero divisor rather than NaN or Infinity. */
export const div = (a, b) => (b === 0 ? 0 : ((a * ONE) / b) | 0);

/**
 * Rounding divide, the counterpart of `mulRound` and for the same reason: a
 * quotient that feeds a *reported* number must not lose its fraction, or the
 * loss compounds through the multiplies that follow it. Every truncation leans
 * the same way, so they add rather than cancel. Only for those; `div` stays
 * the simulation's divide.
 */
export const divRound = (a, b) =>
  b === 0 ? 0 : (((a * ONE) + ((b / 2) | 0)) / b) | 0;

/**
 * Rounded `a * b / c` without ever landing on the intermediate. A ratio taken
 * on its own has to be stored as a Q16.16 fraction of at most 1.0, which
 * quantises it to 1.5e-5 - and once that ratio is scaled up by a thousand the
 * error is scaled with it. Kept as one expression the quotient is only ever
 * rounded at the end, at the precision of the answer rather than the ratio.
 * The caller must know |a*b| stays under 2^53.
 */
export const mulDivRound = (a, b, c) =>
  c === 0 ? 0 : (((a * b) + ((c / 2) | 0)) / c) | 0;

/**
 * Truncating divide of two PLAIN INTEGERS - not Q16.16 values.
 *
 * `div` scales its numerator by ONE first, which is right for fixed-point and
 * wrong for a count. Splitting a hundred parts of something, or a byte into
 * buckets, was being written as `x / n | 0` at the call site, which is exactly
 * the arithmetic the guard exists to keep in one auditable file.
 *
 * Truncates towards zero, as `| 0` does, so it is the same value the inline
 * form produced. Both arguments must already be int32.
 */
export const idiv = (a, b) => (b === 0 ? 0 : (a / b) | 0);

export const min = (a, b) => (a < b ? a : b);
export const max = (a, b) => (a > b ? a : b);
export const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
export const sign = (a) => (a > 0 ? 1 : a < 0 ? -1 : 0);

/**
 * Integer square root of a Q16.16 value, by Newton-Raphson on integers.
 *
 * Math.sqrt is correctly rounded and would in fact be deterministic, but it is
 * banned wholesale rather than by exception: a whitelist with one hole in it is
 * a whitelist somebody widens later.
 */
export function sqrt(x) {
  if (x <= 0) return 0;
  // sqrt(x/ONE)*ONE = sqrt(x*ONE); the product needs 48 bits, so it stays exact
  let n = x * ONE;
  let r = 1 << 15;
  for (let i = 0; i < 24; i++) {
    const next = ((r + (n / r)) / 2) | 0;
    if (next === r) break;
    r = next;
  }
  return r | 0;
}

/**
 * Length of a 2D vector, both components Q16.16.
 *
 * The first version scaled the components down by 256 before squaring, out of
 * caution about overflow, and then applied the FIXED-POINT square root to the
 * result - counting the scale twice. It returned roughly 256x too much, the
 * speed cap fired on the first tick, and the vehicle covered five metres in
 * fifty seconds. No overflow guard was needed: at the map's maximum speed the
 * intermediate is 3.4e12, comfortably inside the exact integer range.
 */
/**
 * Cube root, Q16.16 in and out.
 *
 * `Math.cbrt` is out for the same reason `Math.sqrt` is: it is a host
 * function, and the poison test refuses every one of them. Newton on
 * `y = (2y + x/y^2) / 3`, which is the cube-root iteration written in this
 * file's own operations - `mulFast` for `y^2`, `div` for `x/y^2`, `idiv` for
 * the third - so there is no arithmetic here that is not already tested.
 *
 * Twenty iterations from a power-of-two start. The iteration thirds its error
 * when it is far out, so the largest input this core has - a liquidation
 * capped at 32767 millions, whose root is 32 - is reached in a handful;
 * twenty is the same work for every input, which keeps the cost off the
 * input value.
 *
 * The last three lines are the correction. Newton lands within a unit but not
 * always ON the floor, and a root that is one Q16.16 unit high would make a
 * crater one fifteen-thousandth of a metre wider on one machine and not on
 * another if any step ever rounded differently. So it is walked to the exact
 * floor: the largest y whose cube does not exceed x.
 *
 * Bounds. The caller's x reaches 32767 * ONE = 2.147e9 and the root 32 * ONE.
 * `mulFast(y, y)` peaks at 4.4e12 before its divide and `div(x, t)` at 1.4e14,
 * both exact in a double long before 2^53. Above that the input would have to
 * be a liquidation of thirty-two billion dollars, which `LIQ_MAX` refuses.
 */
export function cbrt(x) {
  if (x <= 0) return 0;

  // THE START MATTERS, and starting at 1.0 does not work. Newton's first step
  // from there is `(2 + x) / 3`, which for x = 1000 lands on 334 - and 334
  // squared in Q16.16 is 7.3e9, past a signed word, so `mulFast` wraps
  // negative and the iteration is destroyed before it has begun. Measured:
  // 1000 came out as 334.15 and 8000 as 2667.
  //
  // So the start is a power of two at the right size. `x` is ONE * v, so
  // log2(x) = 16 + log2(v) and the root is ONE * v^(1/3) = 2^(16 + log2(v)/3).
  // From there the iteration never overshoots and every intermediate stays
  // inside the range the bounds note below promises.
  let bits = -1;
  for (let t = x; t > 0; t >>>= 1) bits++;
  let shift = 16 + (((bits - 16) / 3) | 0);
  if (shift < 0) shift = 0;
  if (shift > 30) shift = 30;
  let y = (1 << shift) | 0;
  if (y < 1) y = 1;

  for (let i = 0; i < 20; i++) {
    const sq = mulFast(y, y);
    if (sq <= 0) break;
    y = idiv(add(add(y, y), div(x, sq)), 3);
    if (y <= 0) { y = 1; break; }
  }

  // The cube is compared, never stored, so it is worked out in the double
  // domain: `mulFast` would wrap at y = 32.0 exactly, where the true cube is
  // 2^31, and a wrap in the CORRECTION would turn "too big" into "far too
  // small" and walk the answer the wrong way. Exact to 2^53, which the bounds
  // note below is well inside.
  const cube = (v) => ((v * v) / ONE) * v / ONE;
  while (y > 1 && cube(y) > x) y = (y - 1) | 0;
  while (cube((y + 1) | 0) <= x) y = (y + 1) | 0;
  return y;
}

export const length2 = (x, y) => {
  if (x === 0 && y === 0) return 0;
  return sqrt((mulFast(x, x) + mulFast(y, y)) | 0);
};
