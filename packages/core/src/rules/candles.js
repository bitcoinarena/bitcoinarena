// THE CANDLES ARE TERRAIN - WAR_TACTICS.md §4.15.
//
// The tape's candles as a height layer the surface reader adds (`surfaceAt = relief + emplacements + candles - craters`),
// on a chart band levelled to the apron's height, with each candle's two x-faces as truck-only walls. Laid over
// x = -104 .. +104: 32 slots of 6.5 m, a 3.7 m body and a 2.8 m corridor in each; a body runs from its open's z to its
// close's z (the seam's own price-to-z scale), at least 1 m long; a plateau 2 m high reached by a 5 m ramp inside each
// z-end. Derived from the tape alone and rebuilt when the tape changes; nothing here is hashed state and nothing draws.
//
// Not here yet (the slice, the owner 2026-09-17): the scroll, the rescale lerp, the seam remap to 208 m, the glow, cover
// lips - and the wick, whose 1 m pillar from low to high covers the whole plateau of a two-sample candle (ruling open).
import { ONE, add, sub, abs, mulFast, div, idiv, min, max, clamp } from '../fixed.js';
import { SAMPLES, FRONT_DEPTH } from './frontline.js';
import { BOX_WORDS } from './solids.js';

export const CANDLES = 32;
export const CANDLE_X0 = -6815744;                 // -104 m, the first slot's west edge
export const CANDLE_SLOT = 425984;                 // 6.5 m
export const CANDLE_BODY_HALF = 121242;            // 1.85 m: a 3.7 m body, a 2.8 m corridor
export const CANDLE_H = 131072;                    // 2 m plateau
export const CANDLE_RAMP = 327680;                 // 5 m ramp inside each z-end
export const CANDLE_MIN_LENGTH = ONE;              // a doji is built 1 m long
export const BAND_X = 6815744;                     // |x| <= 104 m
export const BAND_Z = 4587520;                     // |z| <= 70 m
export const CONE = 26214;                         // 0.4: the grade the relief may rise toward the band

/** Per candle in `layout`: slot centre x, body z from and to (from < to), 1 when close >= open. */
export const CL_X = 0, CL_Z0 = 1, CL_Z1 = 2, CL_GREEN = 3, CL_WORDS = 4;

/** The renderer's view: count, apron height, then per candle x from, x to, z from, z to, plateau height, green. */
export const CV_COUNT = 0, CV_APRON = 1, CV_FIRST = 2, CV_WORDS = 6;
export const CV_TOTAL = CV_FIRST + Math.imul(CANDLES, CV_WORDS);

/** A price as a ground z, by the seam's own scale (frontlineZ): the window's low at -61.2 m, its high at +61.2 m. */
function zOfPrice(p, lo, span, halfZ) {
  if (span <= 0) return 0;
  const t = sub(div(mulFast(sub(p, lo), Math.imul(2, ONE)), span), ONE);
  return mulFast(t, mulFast(halfZ, FRONT_DEPTH));
}

/**
 * The 32 bodies from the tape. Candles pair the round's samples (candle k = round samples 2k, 2k+1, as the HUD's chart
 * does), so which tape sample opens slot 0 follows the parity of the samples taken: `taken` odd drops the oldest sample
 * (its open has left the tape) and leaves the newest slot a doji of the forming candle.
 */
export function candleLayout(tape, taken, halfZ, out) {
  let lo = tape[0], hi = tape[0];
  for (let k = 1; k < SAMPLES; k++) { lo = min(lo, tape[k]); hi = max(hi, tape[k]); }
  const span = sub(hi, lo), shift = taken & 1;
  for (let c = 0; c < CANDLES; c++) {
    const o = min(add(Math.imul(c, 2), shift), SAMPLES - 1), k = min(o + 1, SAMPLES - 1);
    const zo = zOfPrice(tape[o], lo, span, halfZ), zc = zOfPrice(tape[k], lo, span, halfZ);
    let z0 = min(zo, zc), z1 = max(zo, zc);
    if (sub(z1, z0) < CANDLE_MIN_LENGTH) { z0 = sub((z0 + z1) >> 1, CANDLE_MIN_LENGTH >> 1); z1 = add(z0, CANDLE_MIN_LENGTH); }
    const b = Math.imul(c, CL_WORDS);
    out[b + CL_X] = add(add(CANDLE_X0, Math.imul(c, CANDLE_SLOT)), CANDLE_SLOT >> 1);
    out[b + CL_Z0] = z0;
    out[b + CL_Z1] = z1;
    out[b + CL_GREEN] = tape[k] >= tape[o] ? 1 : 0;
  }
  return out;
}

/** The candle layer's height at a world point, Q16.16; 0 in a corridor, off the band's x, and beyond a body's ends. */
export function candleHeightAt(layout, x, z) {
  const dx = sub(x, CANDLE_X0);
  if (dx < 0 || dx >= Math.imul(CANDLES, CANDLE_SLOT)) return 0;
  const c = idiv(dx, CANDLE_SLOT), b = Math.imul(c, CL_WORDS);
  if (abs(sub(x, layout[b + CL_X])) >= CANDLE_BODY_HALF) return 0;
  const z0 = layout[b + CL_Z0], z1 = layout[b + CL_Z1];
  if (z <= z0 || z >= z1) return 0;
  const d = min(sub(z, z0), sub(z1, z));
  return d >= CANDLE_RAMP ? CANDLE_H : mulFast(CANDLE_H, div(d, CANDLE_RAMP));
}

/**
 * The relief inside the chart band is the apron's height; outside it, within the band's x, the relief is held to a 40%
 * cone about that height, `|h - apron| <= 0.4 (|z| - 70)`, so no ground rises (or falls) toward the band faster than a
 * ramp does. Beyond |x| = 104 the relief is untouched.
 */
export function levelled(relief, apron, x, z) {
  if (abs(x) > BAND_X) return relief;
  const az = abs(z);
  if (az <= BAND_Z) return apron;
  const lim = mulFast(CONE, sub(az, BAND_Z));
  return clamp(relief, sub(apron, lim), add(apron, lim));
}

/**
 * Each candle's two x-faces as solid boxes for the truck (resolveSolids): zero thickness on the face line, the body's
 * z-length, from the apron to the plateau. Zero thickness keeps the corridor 2.8 m and the plateau 3.7 m - the circles'
 * radius (1.275 m) is far more than a tick's travel, so a centre never reaches the line.
 */
export function candleWalls(layout, apron) {
  const box = new Int32Array(Math.imul(Math.imul(CANDLES, 2), BOX_WORDS));
  for (let c = 0; c < CANDLES; c++) {
    const l = Math.imul(c, CL_WORDS), z0 = layout[l + CL_Z0], z1 = layout[l + CL_Z1];
    for (let f = 0; f < 2; f++) {
      const b = Math.imul(add(Math.imul(c, 2), f), BOX_WORDS);
      box[b] = f === 0 ? sub(layout[l + CL_X], CANDLE_BODY_HALF) : add(layout[l + CL_X], CANDLE_BODY_HALF);
      box[b + 1] = add(z0, (sub(z1, z0)) >> 1);
      box[b + 2] = 0;
      box[b + 3] = (sub(z1, z0)) >> 1;
      box[b + 4] = apron;
      box[b + 5] = add(apron, CANDLE_H);
    }
  }
  return { n: Math.imul(CANDLES, 2), box };
}

/** The renderer's words (CV_*): what CandleTerrain meshes. Returns the words written. */
export function writeCandleView(layout, apron, out) {
  out[CV_COUNT] = CANDLES;
  out[CV_APRON] = apron;
  for (let c = 0; c < CANDLES; c++) {
    const l = Math.imul(c, CL_WORDS), b = add(CV_FIRST, Math.imul(c, CV_WORDS));
    out[b] = sub(layout[l + CL_X], CANDLE_BODY_HALF);
    out[b + 1] = add(layout[l + CL_X], CANDLE_BODY_HALF);
    out[b + 2] = layout[l + CL_Z0];
    out[b + 3] = layout[l + CL_Z1];
    out[b + 4] = CANDLE_H;
    out[b + 5] = layout[l + CL_GREEN];
  }
  return CV_TOTAL;
}
