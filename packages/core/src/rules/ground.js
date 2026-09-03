// The ground under the truck.
//
// The core had the mempool relief ported and never read it, so a climb cost
// nothing and a descent gave nothing back - the truck drove over the map as
// though it were a table.
//
// The heights are NOT recomputed here from the fee profile. Unity's relief
// uses Mathf.PerlinNoise, which has no seed and no specification, and the
// core's own noise field is a different shape - up to five and a half metres
// different. A core that felt a hill where the player sees flat ground is
// worse than one that feels no hills at all. So the host uploads the height
// field it is actually drawing, once, as round setup data: the same status as
// the fee profile it came from, agreed before the round and hashed with it,
// never touched again while the round runs.

import { ONE, add, sub, mulFast, div, clamp, length2 } from '../fixed.js';

export const DEFAULT_COLS = 160;
export const DEFAULT_ROWS = 96;

/** A field of one height, which is what a flat world is. */
export function flatGround(cols, rows) {
  return { cols, rows, h: new Int32Array(Math.imul(cols, rows)) };
}

/**
 * Surface height at a world position, Q16.16 throughout.
 *
 * A port of MempoolTerrain.SampleSurface, including its triangle split: the
 * mesh is wound (A,B,C) then (C,B,D), so the seam runs from B to C and
 * tx + tz < 1 lands in the first triangle. Interpolating bilinearly instead
 * would put the physics a few centimetres off the visible surface on every
 * cell diagonal, which is a shimmer the player would feel and not see.
 */
export function heightAtWorld(g, x, z, halfX, halfZ) {
  if (!g || g.cols < 2 || g.rows < 2) return 0;

  const u = clamp(add(div(x, Math.imul(halfX, 2)), 32768), 0, ONE);
  const v = clamp(add(div(z, Math.imul(halfZ, 2)), 32768), 0, ONE);

  const fu = mulFast(u, Math.imul(g.cols - 1, ONE));
  const fv = mulFast(v, Math.imul(g.rows - 1, ONE));

  const x0 = clamp(fu >> 16, 0, g.cols - 2);
  const z0 = clamp(fv >> 16, 0, g.rows - 2);
  const tx = sub(fu, Math.imul(x0, ONE));
  const tz = sub(fv, Math.imul(z0, ONE));

  const at = (gx, gz) => g.h[add(Math.imul(gz, g.cols), gx)];
  const a = at(x0, z0), b = at(x0, z0 + 1);
  const c = at(x0 + 1, z0), d = at(x0 + 1, z0 + 1);

  if (add(tx, tz) < ONE) {
    return add(a, add(mulFast(sub(c, a), tx), mulFast(sub(b, a), tz)));
  }
  return add(d, add(mulFast(sub(b, d), sub(ONE, tx)),
                    mulFast(sub(c, d), sub(ONE, tz))));
}

/** How far ahead and behind the slope is read, in metres. */
const REACH = Math.imul(3, ONE);

/**
 * Rise over run along a heading: positive is uphill.
 *
 * Measured over six metres rather than at a point because the truck is 6.4 m
 * long and rides the average, not the pebble under the front axle. It is also
 * the span the reference measurement used, so the number the core fits is the
 * number PhysX was asked for.
 */
export function gradeAlong(sample, x, z, fx, fz) {
  const ax = add(x, mulFast(fx, REACH)), az = add(z, mulFast(fz, REACH));
  const bx = sub(x, mulFast(fx, REACH)), bz = sub(z, mulFast(fz, REACH));
  const rise = sub(sample(ax, az), sample(bx, bz));
  return div(rise, Math.imul(REACH, 2));
}

/**
 * sin(atan(grade)) - the fraction of gravity that acts along the slope.
 *
 * Done as grade / sqrt(1 + grade^2) rather than through the trig table: it is
 * exact for the purpose, it is monotone, and it needs no angle.
 */
export function slopeSin(grade) {
  return div(grade, length2(ONE, grade));
}
