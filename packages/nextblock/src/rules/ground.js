// The ground under the truck.
//
// The core had the mempool relief ported and never read it, so a climb cost
// nothing and a descent gave nothing back - the truck drove over the map as
// though it were a table.
//
// THE HOST USED TO UPLOAD THIS AND NO LONGER MAY, and the reversal is the
// whole of letter 36. The old rule was that Unity sent the height field it was
// drawing, "agreed before the round and hashed with it" - except nothing ever
// hashed it and nothing ever sent it to anybody else. Measured: the page
// uploaded `MempoolTerrain.HeightGrid` into its own core and the committee
// replayed the same drive on `flatGround`, which is 0.000 m apart on the level
// apron and 33.500 m apart six hundred ticks later. A run that leaves flat
// ground was judged in a world nobody drove.
//
// It could not be fixed by sending the grid either way round: `HeightAt` is
// `Mathf.Log10` of a LIVE mempool profile plus `Mathf.PerlinNoise`, a host's
// live data through Unity's own float maths - the thing this package exists to
// avoid - and a player who published their own heights would be choosing the
// world they are scored in.
//
// So the ground is GENERATED HERE, from the round's own seed, in the same
// integers as everything else. Every party that can replay a drive arrives at
// the same hills by construction rather than by agreement, and Unity draws
// what the core says instead of telling it.

import { ONE, add, sub, mulFast, div, clamp, length2 } from '../fixed.js';
import { hash2 } from '../rng.js';

export const DEFAULT_COLS = 160;
export const DEFAULT_ROWS = 96;

/**
 * THE RELIEF, AND EVERY NUMBER IN IT IS A CONSTANT OF THE GAME.
 *
 * A lattice of corner heights drawn from the seed, interpolated across it, in
 * two octaves so the ground rolls rather than stepping. `hash2` is a function
 * of the seed and the corner and of nothing else, so the field can be built in
 * any order and comes out the same - which a stream could not promise.
 */
export const RELIEF_LATTICE_X = 12;
export const RELIEF_LATTICE_Z = 8;
/** How high the tallest hill may stand, Q16.16. Unity's own baseRelief was 5.5 m. */
export const RELIEF_PEAK = Math.imul(6, ONE);

/**
 * BOTH ENDS ARE LEVELLED INTO AN APRON, which is not decoration.
 *
 * `MempoolTerrain` already did this and said why: an apron slab is one plane
 * laid at a single height, so a metre of relief under it is a metre of
 * daylight under one end, and the truck spawned beneath its own loading dock.
 * The bays are here too - 24 doors across 156 m - and a door on a slope is a
 * truck that rolls out of it sideways.
 *
 * Level out to LEVEL_X, easing to full relief by RELIEF_X.
 */
export const LEVEL_X = Math.imul(86, ONE);
export const RELIEF_X = Math.imul(66, ONE);

/** 1 where the ground may roll, 0 on the aprons, eased between. Q16.16. */
export function reliefFactor(x, halfX) {
  const away = x < 0 ? (-x) | 0 : x;
  if (away >= LEVEL_X) return 0;
  if (away <= RELIEF_X) return ONE;
  // Linear between the two, and then smoothed so the join has no crease.
  const t = div(sub(LEVEL_X, away), sub(LEVEL_X, RELIEF_X));
  // 3t^2 - 2t^3, the same ease the rest of the game uses for a blend.
  const tt = mulFast(t, t);
  return clamp(sub(mulFast(Math.imul(3, ONE), tt), mulFast(Math.imul(2, ONE), mulFast(tt, t))), 0, ONE);
}

/** One lattice corner's height, Q16.16, from the seed alone. */
function corner(seedWord, i, j) {
  return mulFast(RELIEF_PEAK, hash2(seedWord, i, j) >>> 16);
}

/**
 * The relief a round is played on, as a height field of `cols` x `rows`.
 *
 * Bilinear across the lattice, plus a second octave at half the scale and a
 * quarter of the height, then levelled into the aprons. Nothing here draws
 * from a stream and nothing here is a float.
 */
export function groundFromSeed(seedWord, cols, rows, halfX, halfZ) {
  const g = flatGround(cols, rows);
  const lastCol = (cols - 1) | 0;
  const lastRow = (rows - 1) | 0;
  for (let r = 0; r < rows; r++) {
    const v = lastRow > 0 ? div(Math.imul(r, ONE), Math.imul(lastRow, ONE)) : 0;
    for (let c = 0; c < cols; c++) {
      const u = lastCol > 0 ? div(Math.imul(c, ONE), Math.imul(lastCol, ONE)) : 0;
      const coarse = octave(seedWord, u, v, RELIEF_LATTICE_X, RELIEF_LATTICE_Z, 0);
      const fine = octave(seedWord, u, v, Math.imul(RELIEF_LATTICE_X, 2), Math.imul(RELIEF_LATTICE_Z, 2), 1);
      const h = add(coarse, fine >> 2);
      // The world x this column stands at, so the aprons can be levelled.
      const x = sub(mulFast(u, Math.imul(halfX, 2)), halfX);
      g.h[Math.imul(r, cols) + c] = mulFast(h, reliefFactor(x, halfX));
    }
  }
  return g;
}

/** One octave: the lattice cell (u, v) falls in, interpolated bilinearly. */
function octave(seedWord, u, v, lx, lz, salt) {
  const fu = mulFast(u, Math.imul(lx, ONE));
  const fv = mulFast(v, Math.imul(lz, ONE));
  const i = fu >> 16;
  const j = fv >> 16;
  const tu = fu & 65535;
  const tv = fv & 65535;
  const a = corner(seedWord, i + Math.imul(salt, 977), j);
  const b = corner(seedWord, i + 1 + Math.imul(salt, 977), j);
  const c = corner(seedWord, i + Math.imul(salt, 977), j + 1);
  const d = corner(seedWord, i + 1 + Math.imul(salt, 977), j + 1);
  const top = add(a, mulFast(sub(b, a), tu));
  const bottom = add(c, mulFast(sub(d, c), tu));
  return add(top, mulFast(sub(bottom, top), tv));
}

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
