// THE CANDLES ARE TERRAIN - WAR_TACTICS.md §4.15, as a RAISED RIBBON (playtest fix 492f128, the owner 2026-09-17 13:51).
//
// The tape's candles as a height layer the surface reader adds (`surfaceAt = relief + candles - craters`),
// on a static chart band levelled to a pancake of the relief. 32 slots of 5.756 m between the apron and the miner (spawn
// ruling B); each body as wide as its slot, bodies touching; a body runs from its open (the previous candle's close - a
// continuous staircase) to its close in z, at least 1 m long. The union of the bodies is a ribbon 1 m above the ground,
// its every free edge a 4 m ramp at 25%: h = H x clamp(d / R, 0, 1), d the distance to the union's boundary. Nothing in
// the chart is a solid - no wall, no wick collider (w1 withdrawn): the chart is the road. The wick and the glow are light.
// It moves: the scroll slides it toward the post office half a slot per sample (frontline.js `scrollOf`), and a new
// window high or low lerps the price-to-z scale over the 300 ticks after the sample. Derived, not hashed: the tape, the
// samples taken and the market words make it.
import { ONE, add, sub, abs, mulFast, div, idiv, min, max, clamp, length2 } from '../fixed.js';
import { SAMPLES, FRONT_DEPTH, FIELD_X0, FIELD_SLOT } from './frontline.js';
import { heightAtWorld } from './ground.js';

export const CANDLES = 32;
// SPAWN RULING B (the owner 2026-09-17): the truck leaves the apron, then meets the chart. The first x-face stands 26 m past
// the spawn centre (START_X -100.4 m; the nose is 3.275 m ahead of it, so the nose meets it 22.7 m out, past the 22 m
// apron), and the 32 slots end at the miner's face (x 108.4 m), so no body stands in the gate throat or across the
// delivery line (x 114). 32 slots over 184.2 m: pitch 5.75625 m, the corridor kept at 2.8 m, the body what is left.
// At 6.5 m (x -104..+104) the first face stood 2.2 m BEHIND the spawn and bays 9-12 started on candle 0.
export const CANDLE_X0 = FIELD_X0;                 // -75.79998 m: first face at -74.39998 m, 26.00001 m past START_X
export const CANDLE_SLOT = FIELD_SLOT;             // 5.18124 m; 32 slots end at 89.99983 m, at the miner's door
export const CANDLE_BODY_HALF = FIELD_SLOT >> 1;   // the full slot: bodies touch (492f128, no padding)
export const CANDLE_H = ONE;                       // 1 m plateau (was 2)
export const CANDLE_RAMP = 262144;                 // 4 m ramp: 1 m over 4 m is 25% (was 5 m at 40%)
export const CANDLE_MIN_LENGTH = ONE;              // a doji is built 1 m long
/**
 * THE WICK IS GROUND TOO (§4.15, the owner 2026-09-17 15:30: "can I drive through it? that would not be logical"): a ridge
 * 0.5 m tall with a 1 m top along the slot's centre line, from the body's end out to the high (and from the low to the
 * body's other end), its sides and far end ramped at 25% (2 m). It runs R into the body, where the body's own ramp is
 * already past 0.5 m, so ridge and body meet without a step. Nothing stands above 1 m; nothing is passed through.
 */
export const WICK_RIDGE_H = ONE >> 1;              // 0.5 m
export const WICK_RIDGE_TOP_HALF = ONE >> 1;       // the 1 m top
export const WICK_RIDGE_RAMP = Math.imul(2, ONE);  // 0.5 m over 2 m: 25%
/**
 * THE RIBBON'S WORLD ENDS (§4.15 "nothing jumps"): the chart scrolls under fixed edges, ramped like any free edge. On the
 * whole-slot move (every second sample) slot 0's candle leaves at -x - west of X0 it has slid fully out, so it does not
 * pop - and a new forming candle is born in slot 31 with no length (`grow`, below), so it does not pop either. The east
 * end is the field's own: nothing stands past it at any scroll.
 */
export const CANDLE_WEST = FIELD_X0;
export const CANDLE_EAST = FIELD_X0 + Math.imul(32, FIELD_SLOT);   // 90.00 m, the miner's door (MINER_DOOR_X 90.4)
export const BAND_X = 6815744;                     // |x| <= 104 m
export const BAND_Z = 3538944;                     // |z| <= 54 m: the seam's 45 m, the 5 m ramp, 4 m
export const CONE = 26214;                         // 0.4: the grade the relief may rise toward the band
export const PANCAKE = 9830;                       // 0.15: the relief inside the band, about the apron's height
export const WICK_HALF = 32768;                    // the wick's light column: 1 m wide
export const WICK_HEIGHT = 589824;                 // 9 m tall - light only, never a solid

/** Per candle in `layout`: slot centre x, body z from and to (from < to), 1 when close >= open, the low's z and the high's z. */
export const CL_X = 0, CL_Z0 = 1, CL_Z1 = 2, CL_GREEN = 3, CL_LOW = 4, CL_HIGH = 5, CL_WORDS = 6;

/**
 * The renderer's view: count, apron height, the forming candle's slot (-1 when every slot is a whole candle; its glow
 * pulses), the scroll as a shift toward -x in metres (Q16.16; the slots below are unshifted), then per candle x from, x to, z from, z to, plateau height, green, and the wick's
 * collider past the body: low wick z from (= body z from when none), high wick z to (= body z to when none).
 */
export const CV_COUNT = 0, CV_APRON = 1, CV_FORMING = 2, CV_SHIFT = 3, CV_FIRST = 4, CV_WORDS = 8;
export const CV_TOTAL = CV_FIRST + Math.imul(CANDLES, CV_WORDS);

/** A price as a ground z, by the seam's own scale (frontlineZ): the window's low at -45 m, its high at +45 m. */
function zOfPrice(p, lo, span, halfZ) {
  if (span <= 0) return 0;
  const t = sub(div(mulFast(sub(p, lo), Math.imul(2, ONE)), span), ONE);
  return mulFast(t, mulFast(halfZ, FRONT_DEPTH));
}

/**
 * The 32 bodies from the tape. Candles pair the round's samples (candle k = round samples 2k, 2k+1, as the HUD's chart
 * does), so which tape sample starts slot 0 follows the parity of the samples taken: `taken` odd drops the oldest sample
 * and leaves the newest slot the forming candle.
 *
 * A CONTINUOUS STAIRCASE (§4.15, the owner 2026-09-17 13:42; found on the live top-down: scattered pillars with gaps). The
 * tape is a series of closes: candle c's open is the previous candle's close (sample 2c - 1; the first slot's open is its
 * own first sample, the one before it has left the tape), its close sample 2c + 1, its low and high the min and max of
 * those three samples. Every body starts where the last one ended.
 */
export function candleLayout(tape, taken, halfZ, out, scaleLo = null, scaleHi = null, older = tape[0], grow = ONE) {
  let lo = tape[0], hi = tape[0];
  for (let k = 1; k < SAMPLES; k++) { lo = min(lo, tape[k]); hi = max(hi, tape[k]); }
  if (scaleLo !== null) { lo = scaleLo; hi = scaleHi; }
  const span = sub(hi, lo), shift = taken & 1;
  for (let c = 0; c < CANDLES; c++) {
    const first = min(add(Math.imul(c, 2), shift), SAMPLES - 1), k = min(first + 1, SAMPLES - 1);
    // slot 0's open before the tape: the sample that left it last (the glide), so the open does not jump when it leaves
    const zo = zOfPrice(first > 0 ? tape[first - 1] : older, lo, span, halfZ), zc = zOfPrice(tape[k], lo, span, halfZ);
    const zm = zOfPrice(tape[first], lo, span, halfZ);
    let z0 = min(zo, zc), z1 = max(zo, zc);
    // A forming candle is born with its open and its (glided) close on one z: its doji length grows with the glide too,
    // 0 to 1 m over the sample's 300 ticks, so a new body rises out of the ground instead of standing there at once.
    const minLength = (shift === 1 && c === CANDLES - 1) ? mulFast(CANDLE_MIN_LENGTH, grow) : CANDLE_MIN_LENGTH;
    if (sub(z1, z0) < minLength) { z0 = sub((z0 + z1) >> 1, minLength >> 1); z1 = add(z0, minLength); }
    const b = Math.imul(c, CL_WORDS);
    out[b + CL_X] = add(add(CANDLE_X0, Math.imul(c, CANDLE_SLOT)), CANDLE_SLOT >> 1);
    out[b + CL_Z0] = z0;
    out[b + CL_Z1] = z1;
    out[b + CL_GREEN] = tape[k] >= (first > 0 ? tape[first - 1] : older) ? 1 : 0;
    // The low and high over the three samples: the middle one stands past the body when the price went beyond both
    // ends inside the candle - that is the wick (w1: a collider only there).
    out[b + CL_LOW] = min(min(zo, zc), zm);
    out[b + CL_HIGH] = max(max(zo, zc), zm);
  }
  return out;
}

/**
 * The candle layer's height at a world point, Q16.16: the ribbon. `shift` is the scroll in metres toward -x (the layout's
 * slots are unshifted). Inside a body: H, less the ramp within R of the union's boundary - its own z-ends, and the parts of
 * its x-faces its neighbour does not cover (the distance to such a part's nearest end where the neighbour does cover the
 * point's z). A slot is wider than R, so no boundary two slots away is within reach. 0 off the ribbon.
 */
export function candleHeightAt(layout, x, z, shift = 0) {
  if (x <= CANDLE_WEST || x >= CANDLE_EAST) return 0;
  const xs = add(x, shift);
  const dx = sub(xs, CANDLE_X0);
  if (dx < 0 || dx >= Math.imul(CANDLES, CANDLE_SLOT)) return 0;
  const c = idiv(dx, CANDLE_SLOT), b = Math.imul(c, CL_WORDS);
  const z0 = layout[b + CL_Z0], z1 = layout[b + CL_Z1];
  const clip = min(sub(x, CANDLE_WEST), sub(CANDLE_EAST, x));
  const ridge = wickRidge(layout, b, sub(xs, add(CANDLE_X0, add(Math.imul(c, CANDLE_SLOT), CANDLE_SLOT >> 1))), z, clip);
  if (z <= z0 || z >= z1) return ridge;
  let d = min(min(sub(z, z0), sub(z1, z)), clip);
  const left = sub(xs, add(CANDLE_X0, Math.imul(c, CANDLE_SLOT))), right = sub(Math.imul(CANDLE_SLOT, 1), left);
  if (left < CANDLE_RAMP) d = min(d, faceDistance(layout, c - 1, z0, z1, z, left));
  if (right < CANDLE_RAMP) d = min(d, faceDistance(layout, c + 1, z0, z1, z, right));
  const body = d >= CANDLE_RAMP ? CANDLE_H : mulFast(CANDLE_H, div(d, CANDLE_RAMP));
  return max(body, ridge);
}

/**
 * The wick ridge of the candle at layout offset `b`, at `across` from the slot's centre line and `z`: 0.5 m on its 1 m
 * top, down 25% to 0 over 2 m at its sides, at its far end (the high, the low) and at the field's fixed ends (`clip`).
 */
function wickRidge(layout, b, across, z, clip) {
  const side = sub(add(WICK_RIDGE_TOP_HALF, WICK_RIDGE_RAMP), abs(across));
  if (side <= 0) return 0;
  const z0 = layout[b + CL_Z0], z1 = layout[b + CL_Z1], lo = layout[b + CL_LOW], hi = layout[b + CL_HIGH];
  let along = -1;
  // the low wick from the low into the body, the high wick from the body out to the high; each also ramps down toward its
  // inner end R inside the body, which a short body (a doji) does not reach - no step where it stops
  if (lo < z0 && z > lo && z < add(z0, CANDLE_RAMP)) along = min(sub(z, lo), sub(add(z0, CANDLE_RAMP), z));
  if (hi > z1 && z < hi && z > sub(z1, CANDLE_RAMP)) along = max(along, min(sub(hi, z), sub(z, sub(z1, CANDLE_RAMP))));
  if (along <= 0) return 0;
  const d = min(min(side, along), clip);
  return d >= WICK_RIDGE_RAMP ? WICK_RIDGE_H : mulFast(WICK_RIDGE_H, div(d, WICK_RIDGE_RAMP));
}

/**
 * Distance from a point `across` metres inside a body's x-face (at height z, the body spanning z0..z1) to the free part of
 * that face - where the neighbour in slot `n` does not cover. No neighbour: the whole face is free.
 */
function faceDistance(layout, n, z0, z1, z, across) {
  if (n < 0 || n >= CANDLES) return across;
  const nb = Math.imul(n, CL_WORDS), n0 = layout[nb + CL_Z0], n1 = layout[nb + CL_Z1];
  if (z <= n0 || z >= n1) return across;                 // the neighbour does not cover this z: the face is free here
  let best = 2147483647;
  if (n0 > z0) best = min(best, length2(across, sub(z, n0)));   // the free part below the neighbour
  if (n1 < z1) best = min(best, length2(across, sub(n1, z)));   // the free part above it
  return best;
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

/** Nothing in the chart is a solid (492f128): no x-face walls, no wick collider. Kept so the caller has one shape. */
export function candleWalls() {
  return { n: 0, box: new Int32Array(0) };
}

/** The renderer's words (CV_*): what CandleTerrain meshes. Returns the words written. */
export function writeCandleView(layout, apron, out, taken = 0, shift = 0) {
  out[CV_COUNT] = CANDLES;
  out[CV_APRON] = apron;
  out[CV_SHIFT] = shift;
  out[CV_FORMING] = (taken & 1) ? CANDLES - 1 : -1;       // odd: the newest slot has one sample
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
