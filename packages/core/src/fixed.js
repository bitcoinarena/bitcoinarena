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
 * Exact multiply for anything that could overflow the double's integer range.
 * BigInt is exact at any width; it allocates, so it stays off per-unit inner
 * loops by convention rather than by enforcement.
 */
export const mulWide = (a, b) =>
  Number((BigInt(a) * BigInt(b)) >> BigInt(SHIFT)) | 0;

/** Truncating divide. Returns 0 for a zero divisor rather than NaN or Infinity. */
export const div = (a, b) => (b === 0 ? 0 : ((a * ONE) / b) | 0);

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
export const length2 = (x, y) => {
  if (x === 0 && y === 0) return 0;
  return sqrt((mulFast(x, x) + mulFast(y, y)) | 0);
};
