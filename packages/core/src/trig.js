// Trigonometry from the committed table. No Math.sin is ever called.
//
// Angles are Q16.16 TURNS: 0 .. 65536 is a full circle, which makes wrapping a
// free & 0xFFFF and removes every question about pi.

import { QUARTER, SIN_Q } from './tables.js';
import { ONE } from './fixed.js';

const TURN = 65536;
const QUARTER_TURN = 16384;

/** sin of an angle in Q16.16 turns, result Q16.16. */
export function sin(a) {
  let t = a & 65535;                          // wrap into one turn
  let negate = 0;
  if (t >= 32768) { t = (t - 32768) | 0; negate = 1; }
  if (t >= QUARTER_TURN) t = (32768 - t) | 0; // mirror about the quarter

  // index into the quarter wave, plus a fraction for interpolation
  const scaled = Math.imul(t, QUARTER);       // t * 4096, exact below 2^31
  const idx = (scaled / QUARTER_TURN) | 0;
  const rem = (scaled - Math.imul(idx, QUARTER_TURN)) | 0;

  const a0 = SIN_Q[idx];
  const a1 = SIN_Q[idx + 1 > QUARTER ? QUARTER : idx + 1];
  const step = (a1 - a0) | 0;
  const v = (a0 + (((step * rem) / QUARTER_TURN) | 0)) | 0;
  return negate ? (-v) | 0 : v;
}

/** cos is sin a quarter turn ahead. */
export const cos = (a) => sin((a + QUARTER_TURN) | 0);

/**
 * atan2 by integer CORDIC, returning Q16.16 turns.
 *
 * Sixteen rotations gives about 1/65536 of a turn, which is the representable
 * resolution - more iterations would add nothing the type can hold.
 */
const ATAN_T = new Int32Array([
  8192, 4836, 2555, 1297, 651, 326, 163, 81,
  41, 20, 10, 5, 3, 1, 1, 0,
]);

export function atan2(y, x) {
  if (x === 0 && y === 0) return 0;
  let ax = x, ay = y, angle = 0;

  // fold into the first quadrant, remembering where we came from
  if (ax < 0) {
    ax = (-ax) | 0; ay = (-ay) | 0;
    angle = 32768;
  }
  let vx = ax, vy = ay;
  let rot = 0;
  for (let i = 0; i < 16; i++) {
    const dx = vx >> i, dy = vy >> i;
    if (vy > 0) { vx = (vx + dy) | 0; vy = (vy - dx) | 0; rot = (rot + ATAN_T[i]) | 0; }
    else { vx = (vx - dy) | 0; vy = (vy + dx) | 0; rot = (rot - ATAN_T[i]) | 0; }
  }
  return (angle + rot) & 65535;
}
