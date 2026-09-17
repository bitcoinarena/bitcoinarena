// THE CANDLES ARE TERRAIN - WAR_TACTICS.md §4.15.
//
// The tape's candles as a height layer the surface reader adds (`surfaceAt = relief + emplacements + candles - craters`),
// on a static chart band levelled to a pancake of the relief, with each candle's two x-faces as truck-only walls. Laid
// between the apron and the miner (spawn ruling B, the owner 2026-09-17): 32 slots of 5.756 m, a 2.956 m body and a 2.8 m
// corridor in each; a body runs from its open's z to its
// close's z (the seam's own price-to-z scale), at least 1 m long; a plateau 2 m high reached by a 5 m ramp inside each
// z-end. Derived from the tape alone and rebuilt when the tape changes; nothing here is hashed state and nothing draws.
//
// Not here yet (the slice, the owner 2026-09-17): the scroll, the rescale lerp, the seam remap to 208 m, the glow, cover
// lips. The wick (ruled w1, the owner 2026-09-17): a truck-only collider only where the wick stands past the body - the body
// owns the 2 m plateau; a high wick above the body's high end, a low wick below its low end, never through the body.
import { ONE, add, sub, abs, mulFast, div, idiv, min, max, clamp } from '../fixed.js';
import { SAMPLES, FRONT_DEPTH, FIELD_X0, FIELD_SLOT } from './frontline.js';
import { BOX_WORDS } from './solids.js';
import { heightAtWorld } from './ground.js';

export const CANDLES = 32;
// SPAWN RULING B (the owner 2026-09-17): the truck leaves the apron, then meets the chart. The first x-face stands 26 m past
// the spawn centre (START_X -100.4 m; the nose is 3.275 m ahead of it, so the nose meets it 22.7 m out, past the 22 m
// apron), and the 32 slots end at the miner's face (x 108.4 m), so no body stands in the gate throat or across the
// delivery line (x 114). 32 slots over 184.2 m: pitch 5.75625 m, the corridor kept at 2.8 m, the body what is left.
// At 6.5 m (x -104..+104) the first face stood 2.2 m BEHIND the spawn and bays 9-12 started on candle 0.
export const CANDLE_X0 = FIELD_X0;                 // -75.79998 m: first face at -74.39998 m, 26.00001 m past START_X
export const CANDLE_SLOT = FIELD_SLOT;             // 5.75624 m; 32 slots end at 108.39969 m, before the miner face
export const CANDLE_BODY_HALF = 96870;             // 1.47812 m: a 2.95624 m body (0.203 m a side for a 2.55 m truck), a 2.80001 m corridor
export const CANDLE_H = 131072;                    // 2 m plateau
export const CANDLE_RAMP = 327680;                 // 5 m ramp inside each z-end
export const CANDLE_MIN_LENGTH = ONE;              // a doji is built 1 m long
export const BAND_X = 6815744;                     // |x| <= 104 m
export const BAND_Z = 3538944;                     // |z| <= 54 m: the seam's 45 m, the 5 m ramp, 4 m
export const CONE = 26214;                         // 0.4: the grade the relief may rise toward the band
export const PANCAKE = 9830;                       // 0.15: the relief inside the band, about the apron's height
export const WICK_HALF = 32768;                    // a 1 m x 1 m pillar
export const WICK_HEIGHT = 589824;                 // 9 m

/** Per candle in `layout`: slot centre x, body z from and to (from < to), 1 when close >= open, the low's z and the high's z. */
export const CL_X = 0, CL_Z0 = 1, CL_Z1 = 2, CL_GREEN = 3, CL_LOW = 4, CL_HIGH = 5, CL_WORDS = 6;

/**
 * The renderer's view: count, apron height, then per candle x from, x to, z from, z to, plateau height, green, and the wick's
 * collider past the body: low wick z from (= body z from when none), high wick z to (= body z to when none).
 */
export const CV_COUNT = 0, CV_APRON = 1, CV_FIRST = 2, CV_WORDS = 8;
export const CV_TOTAL = CV_FIRST + Math.imul(CANDLES, CV_WORDS);

/** A price as a ground z, by the seam's own scale (frontlineZ): the window's low at -45 m, its high at +45 m. */
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
    // The candle's low and high are its samples' own: with two samples a candle they are the body's ends, so no wick
    // stands past the body on this tape and no wick collider is made.
    out[b + CL_LOW] = min(zo, zc);
    out[b + CL_HIGH] = max(zo, zc);
  }
  return out;
}

/** The candle layer's height at a world point, Q16.16; 0 in a corridor, off the field's x, and beyond a body's ends. */
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
 * STATIC, NOT DYNAMIC (§4.15, the owner 2026-09-17 09:40): the band is fixed, so no ground moves under a wheel. Inside
 * |x| <= 104, |z| <= 54 the relief is a pancake - `apron + 0.15 (relief - apron)`, the mempool's swells kept low. Outside
 * it, within the band's x, the relief is held to a 40% cone from the pancake at the band's edge,
 * `|h - edge| <= 0.4 (|z| - 54)` (12.4 m at the map's edge), so no ground rises (or falls) toward the band faster than a
 * ramp does. The edge's pancake is read from `ground`, unlevelled. Beyond |x| = 104 the relief is untouched.
 */
export function levelled(relief, apron, x, z, ground, halfX, halfZ) {
  if (abs(x) > BAND_X) return relief;
  const az = abs(z);
  if (az <= BAND_Z) return add(apron, mulFast(PANCAKE, sub(relief, apron)));
  const edgeRelief = heightAtWorld(ground, x, z < 0 ? -BAND_Z : BAND_Z, halfX, halfZ);
  const edge = add(apron, mulFast(PANCAKE, sub(edgeRelief, apron)));
  const lim = mulFast(CONE, sub(az, BAND_Z));
  return clamp(relief, sub(edge, lim), add(edge, lim));
}

/**
 * The wick's collider segments of candle `c` past its body, [z from, z to] each, or none: the low wick from the low's z to
 * the body's low end, the high wick from the body's high end to the high's z. Written into `out` (4 words); returns how many.
 */
export function wickSegments(layout, c, out) {
  const l = Math.imul(c, CL_WORDS);
  let n = 0;
  if (layout[l + CL_LOW] < layout[l + CL_Z0]) { out[0] = layout[l + CL_LOW]; out[1] = layout[l + CL_Z0]; n = 1; }
  if (layout[l + CL_HIGH] > layout[l + CL_Z1]) { out[Math.imul(n, 2)] = layout[l + CL_Z1]; out[Math.imul(n, 2) + 1] = layout[l + CL_HIGH]; n = n + 1; }
  return n;
}

/**
 * Each candle's two x-faces as solid boxes for the truck (resolveSolids): zero thickness on the face line, the body's
 * z-length, from the apron to the plateau. Zero thickness keeps the corridor 2.8 m and the plateau 3.7 m - the circles'
 * radius (1.275 m) is far more than a tick's travel, so a centre never reaches the line. Then the wick past the body
 * (w1): a 1 m x 1 m, 9 m pillar over each protruding segment only, at the candle's centre x.
 */
export function candleWalls(layout, apron) {
  const box = new Int32Array(Math.imul(Math.imul(CANDLES, 4), BOX_WORDS));
  const seg = new Int32Array(4);
  let n = 0;
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
    n = add(n, 2);
  }
  for (let c = 0; c < CANDLES; c++) {
    const k = wickSegments(layout, c, seg);
    for (let w = 0; w < k; w++) {
      const b = Math.imul(n, BOX_WORDS), z0 = seg[Math.imul(w, 2)], z1 = seg[Math.imul(w, 2) + 1];
      box[b] = layout[Math.imul(c, CL_WORDS) + CL_X];
      box[b + 1] = add(z0, (sub(z1, z0)) >> 1);
      box[b + 2] = WICK_HALF;
      box[b + 3] = (sub(z1, z0)) >> 1;
      box[b + 4] = apron;
      box[b + 5] = add(apron, WICK_HEIGHT);
      n = add(n, 1);
    }
  }
  return { n, box };
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
    out[b + 6] = min(layout[l + CL_LOW], layout[l + CL_Z0]);
    out[b + 7] = max(layout[l + CL_HIGH], layout[l + CL_Z1]);
  }
  return CV_TOTAL;
}
