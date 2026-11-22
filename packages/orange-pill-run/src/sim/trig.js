// Deterministic trigonometry for the simulation (kanban #3246). Math.sin / Math.hypot / Math.sqrt are
// "implementation-approximated" in ECMAScript and may differ in the last bits between engines, which over
// thousands of steps can change a score. Here everything is built from + - * / and Math.floor/round only,
// which IEEE-754 doubles make bit-identical in V8, SpiderMonkey and JavaScriptCore. Drawing may use Math.*.
const PI = 3.141592653589793;
const TWO_PI = 2 * PI;
export const SIN_N = 4096;                       // table entries per full turn
const SIN_ONE = 65536;                           // table values are sin * 65536, rounded to integers
const SIN_TABLE = new Int32Array(SIN_N);

// Taylor series on [0, pi/2]; terms up to x^23 are below 1e-17 there
function sinSeries(a) {
  const a2 = a * a; let term = a, sum = a;
  for (let k = 1; k <= 11; k++) { term = -term * a2 / ((2 * k) * (2 * k + 1)); sum += term; }
  return sum;
}
for (let i = 0; i < SIN_N; i++) {
  let a = TWO_PI * i / SIN_N, sign = 1;
  if (a > PI) { a -= PI; sign = -1; }
  if (a > PI / 2) a = PI - a;
  SIN_TABLE[i] = Math.round(sign * sinSeries(a) * SIN_ONE);
}
const RAD_TO_IDX = SIN_N / TWO_PI;

// sin of an angle in table units (SIN_N per turn), any integer
export function sinIdx(i) { return SIN_TABLE[((i % SIN_N) + SIN_N) % SIN_N] / SIN_ONE; }
// sin of an angle in radians, to the nearest table entry (error below 0.0008)
export function sinRad(x) { return sinIdx(Math.floor(x * RAD_TO_IDX + 0.5)); }

// square root by Newton steps from a power-of-two start: deterministic, correct to ~1e-15 relative
export function sqrtD(s) {
  if (!(s > 0)) return 0;
  let g = 1;
  if (s >= 1) { while (g * g < s) g *= 2; } else { while (g * g > s) g /= 2; g *= 2; }
  for (let k = 0; k < 8; k++) g = (g + s / g) / 2;
  return g;
}
export function hypotD(dx, dy) { return sqrtD(dx * dx + dy * dy); }
