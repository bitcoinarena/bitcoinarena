// THE CHART THE HUD DRAWS (WAR_TACTICS.md §0.3). One TradingView chart with the truck on it, in two ranges: GROUND, the
// 32 candles on the terrain now (the minimap), and ROUND, every candle since the round's open (the lead). `Tab` picks
// the range in the client; everything the client paints comes out of here, so a HUD cannot put a candle, a price or
// the truck anywhere the core does not.
//
// A view, never a rule: nothing here writes state, and nothing in a step reads it. The mapping is §0.3's - on the
// ground x is time and z is price, so a point's candle is the tape sample under its x and its price is its z read
// through the window's scale, the inverse of `frontlineZ`.
import { ONE, mulFast, div, idiv, abs, min, max } from './fixed.js';
import { O_TACTICS, O_TRUCK, T_X, T_Z, T_HEADING } from './state.js';
import { HALF_X, HALF_Z, frontAt, scrollNow, scaleNow } from './sim.js';
import { SAMPLES, FRONT_DEPTH, tapeAtX, xAtTape } from './rules/frontline.js';
import { GATE_X } from './rules/gate.js';
import { TAC_MARKET, MK_OPEN, MK_SAMPLES, MK_TREND, MK_STRENGTH, MK_LEAD, MK_MOMENTUM, OBJECTIVES, objectiveLane,
  objectiveHolder, objectiveCandle, objectivePresent, assaultPhase, assaultTarget, slotX, candleColour, trendCandle, trendEnd } from './rules/tactics.js';

export const CHART_GROUND = 0, CHART_ROUND = 1;
/** Header words of `chartView`'s output. Prices are in the tape's unit (CHART_UNIT per dollar); t is Q16.16 candles
 *  from the left edge of the range (candle i spans i..i+1). */
export const CH_RANGE = 0, CH_CANDLES = 1, CH_LO = 2, CH_HI = 3, CH_LAST = 4, CH_OPEN = 5, CH_LEAD = 6, CH_LEAD_BP = 7;
export const CH_MOMENTUM = 8, CH_TREND = 9, CH_STRENGTH = 10, CH_DOTS = 11, CH_FIRST = 12, CH_CANDLE_SECONDS = 13;
export const CH_UNIT = 14, CH_YOU_T = 15, CH_YOU_P = 16, CH_YOU_HEADING = 17, CH_YOU_ON = 18, CH_GATE_T = 19;
export const CH_GATE_ON = 20, CH_WINDOW_FROM = 21, CH_WINDOW_TO = 22, CH_SAMPLES = 23;
/** The range's HIGH and LOW: the candle holding the highest high and the lowest low, t of its centre and the price. */
export const CH_HIGH_T = 24, CH_HIGH_P = 25, CH_LOW_T = 26, CH_LOW_P = 27;
/** Per objective (HIGH, LOW, OPEN, §4.11): its kind, t (its candle's centre), price (the seam over that candle), holder, on
 *  the range - 0 when its candle is off the range, and always for an absent OPEN. */
export const CH_OBJ = 28, CH_OBJ_WORDS = 5;
/** Per side (bulls, then bears): the assault's phase, target objective, the target lane's t, on the range, and the
 *  lane's two edges in t (half a slot pitch either side). */
export const CH_ASSAULT = 43, CH_ASSAULT_WORDS = 6;
/** Then CH_CANDLES x (open, high, low, close), then CH_CANDLES seam prices (CH_NONE off the ground window). */
export const CH_CANDLE = 55, CH_MAX_CANDLES = 512, CH_WORDS = 2615;
export const CH_NONE = -2147483648;
/** A point's place on the chart: t, price, on the range. */
export const CH_POINT_WORDS = 3;
const CANDLE_SECONDS = 10, CHART_UNIT = 256;
const LAST = SAMPLES - 1, LAST_Q = Math.imul(SAMPLES - 1, ONE);

/** Samples in the round so far: the open's candle (two) and every sample since. */
const roundLength = (st) => (st.i32[O_TACTICS + TAC_MARKET + MK_SAMPLES] + 2) | 0;

/** Round sample r (0 = the open candle's first). The tape holds the newest SAMPLES; the round's memory the rest. */
function sampleAt(st, L, r) {
  const back = (L - 1 - r) | 0;
  if (back < SAMPLES) return st.tape[LAST - back];
  return st.roundTape[r];
}

/** The candles in a range: [first, last] by round candle index (candle k = samples 2k, 2k+1; 0 holds the open). */
function rangeOf(st, range) {
  const L = roundLength(st);
  const last = (L - 1) >> 1;                         // the newest, still forming when L is odd
  let first;
  if (range === CHART_GROUND) first = (L - SAMPLES + 1) >> 1;   // the whole candles still on the tape
  else first = st.roundTape && st.roundTape.length === L ? 0 : (max(0, L - SAMPLES) + 1) >> 1;
  if (last - first + 1 > CH_MAX_CANDLES) first = (last - CH_MAX_CANDLES + 1) | 0;
  return { L, first, n: (last - first + 1) | 0 };
}

/** The tape window's low and high: the scale the seam is laid across the ground with. */
function windowScale(st) {
  return scaleNow(st);           // the window as the world draws it this tick (§4.15 rescale lerp)
}

/** A ground z as a price: the inverse of `frontlineZ`'s scale. */
function priceAtZ(w, z) {
  const span = (w.hi - w.lo) | 0;
  const mid = (w.lo + (span >> 1)) | 0;
  if (span <= 0) return w.lo;
  return (mid + mulFast(div(z, mulFast(HALF_Z, FRONT_DEPTH)), span >> 1)) | 0;
}

/** A ground x as a round sample, Q16.16. */
const sampleOfX = (st, L, x) => (tapeAtX(x, st.i32[O_TACTICS + TAC_MARKET + MK_SAMPLES], scrollNow(st)) + Math.imul(L - SAMPLES, ONE)) | 0;
/** A round sample (Q16.16) as t in a range starting at candle `first`. */
const tOfSample = (first, rq) => ((rq - Math.imul(first, Math.imul(2, ONE)) + (ONE >> 1)) >> 1) | 0;
const onRange = (n, t) => (t >= 0 && t <= Math.imul(n, ONE) ? 1 : 0);

/**
 * Where a ground point sits on the chart in `range`: out[0] t, out[1] price, out[2] 1 when it is inside the range.
 * The truck, a ghost, the gate - one mapping for all of them.
 */
export function chartPoint(st, range, x, z, out) {
  const r = rangeOf(st, range | 0), w = windowScale(st);
  const t = tOfSample(r.first, sampleOfX(st, r.L, x | 0));
  out[0] = t;
  out[1] = priceAtZ(w, z | 0);
  out[2] = onRange(r.n, t);
  return CH_POINT_WORDS;
}

/** The chart in `range`, written into `out` (at least CH_WORDS long). Returns the words written. */
export function chartView(st, range, out) {
  const s = st.i32, m = O_TACTICS + TAC_MARKET;
  const rg = range === CHART_ROUND ? CHART_ROUND : CHART_GROUND;
  const r = rangeOf(st, rg), w = windowScale(st), n = r.n, L = r.L;
  const count = s[m + MK_SAMPLES];

  out[CH_RANGE] = rg;
  out[CH_CANDLES] = n;
  out[CH_FIRST] = r.first;
  out[CH_CANDLE_SECONDS] = CANDLE_SECONDS;
  out[CH_UNIT] = CHART_UNIT;
  out[CH_SAMPLES] = count;
  const open = s[m + MK_OPEN], last = st.tape[LAST];
  out[CH_LAST] = last;
  out[CH_OPEN] = open;
  out[CH_LEAD] = s[m + MK_LEAD];
  out[CH_MOMENTUM] = s[m + MK_MOMENTUM];
  out[CH_TREND] = s[m + MK_TREND];
  out[CH_STRENGTH] = s[m + MK_STRENGTH];
  const bp = idiv(abs(open), 10000);
  out[CH_LEAD_BP] = bp > 0 ? idiv((last - open) | 0, bp) : 0;
  // The six candles the trend is read from (§4.14), newest in bits 0-1: 1 green, 2 red, 0 doji.
  // THE SAME FUNCTION THE TREND USES (tactics.js `trendCandle`), not a second copy of the indexing: this held its own
  // copy, and when the copy graded half a body so did the dots - which is why the owner's 21:39 shot had six dots that
  // disagreed with the five red candles drawn above them on the same HUD.
  let dots = 0;
  const end = trendEnd(st.tape, count);
  for (let c = 0; c < 6; c++) {
    const col = trendCandle(st.tape, end, c);
    dots |= (col > 0 ? 1 : col < 0 ? 2 : 0) << Math.imul(c, 2);
  }
  out[CH_DOTS] = dots;

  // Candles, and the range's price scale: GROUND is the window the seam is laid with; ROUND the candles' own and the
  // seam over them, so the one indicator never runs off the chart (measured: round-open's seam 931 px, under a chart
  // ending at 741).
  let lo = w.lo, hi = w.hi, highP = CH_NONE, lowP = 2147483647, highT = 0, lowT = 0;
  if (rg === CHART_ROUND) { lo = sampleAt(st, L, Math.imul(r.first, 2)); hi = lo; }
  for (let i = 0; i < n; i++) {
    const k = (r.first + i) | 0, a = Math.imul(k, 2);
    // THE STAIRCASE (§4.15, 2026-09-17 13:42), the world candles' own rule: open = the previous candle's close (sample
    // a - 1, where GROUND's tape - or ROUND's memory - still has it), close = sample a + 1, low / high over the three.
    const m0 = sampleAt(st, L, a), c = a + 1 <= L - 1 ? sampleAt(st, L, a + 1) : m0;
    // on the tape, or in the round's memory (GROUND's first candle too: the world's slot 0 opens on the sample that left)
    const prev = (L - a) < SAMPLES || (a - 1 >= 0 && st.roundTape && st.roundTape.length === L);
    const o = prev ? sampleAt(st, L, a - 1) : m0;
    const hiC = max(max(o, c), m0), loC = min(min(o, c), m0);
    const b = CH_CANDLE + Math.imul(i, 4);
    out[b] = o; out[b + 1] = hiC; out[b + 2] = loC; out[b + 3] = c;
    if (rg === CHART_ROUND) { lo = min(lo, loC); hi = max(hi, hiC); }
    const centre = (Math.imul(i, ONE) + (ONE >> 1)) | 0;
    if (hiC > highP) { highP = hiC; highT = centre; }
    if (loC < lowP) { lowP = loC; lowT = centre; }
    // The seam over this candle, where the candle is on the ground at all.
    const aq = (Math.imul(a, ONE) + (ONE >> 1) - Math.imul(L - SAMPLES, ONE)) | 0;
    const front = CH_CANDLE + Math.imul(n, 4) + i;
    if (aq < 0 || aq > LAST_Q) out[front] = CH_NONE;
    else out[front] = priceAtZ(w, frontAt(st, xAtTape(aq, count, scrollNow(st))));
    if (rg === CHART_ROUND && out[front] !== CH_NONE) { lo = min(lo, out[front]); hi = max(hi, out[front]); }
  }
  out[CH_HIGH_T] = highT; out[CH_HIGH_P] = highP; out[CH_LOW_T] = lowT; out[CH_LOW_P] = lowP;
  out[CH_LO] = lo;
  out[CH_HI] = hi;

  const t0 = tOfSample(r.first, Math.imul(L - SAMPLES, ONE)), t1 = tOfSample(r.first, Math.imul(L - 1, ONE));
  out[CH_WINDOW_FROM] = max(0, t0);
  out[CH_WINDOW_TO] = min(Math.imul(n, ONE), t1);

  const p = [0, 0, 0];
  chartPoint(st, rg, s[O_TRUCK + T_X], s[O_TRUCK + T_Z], p);
  out[CH_YOU_T] = p[0]; out[CH_YOU_P] = p[1]; out[CH_YOU_ON] = p[2];
  out[CH_YOU_HEADING] = s[O_TRUCK + T_HEADING];
  chartPoint(st, rg, GATE_X, 0, p);
  out[CH_GATE_T] = p[0]; out[CH_GATE_ON] = p[2];

  for (let o = 0; o < OBJECTIVES; o++) {
    const b = CH_OBJ + Math.imul(o, CH_OBJ_WORDS);
    out[b] = o; out[b + 3] = objectiveHolder(s, O_TACTICS, o);
    // ITS CANDLE (§4.11): the centre of the candle the objective was read from, and the seam over it where it is on the
    // ground - the same place the marker stands in the world. Absent (OPEN with no crossing), or off this range: off.
    const k = objectiveCandle(s, O_TACTICS, o), i = (k - r.first) | 0;
    if (!objectivePresent(s, O_TACTICS, o) || i < 0 || i >= n) { out[b + 1] = 0; out[b + 2] = CH_NONE; out[b + 4] = 0; continue; }
    out[b + 1] = (Math.imul(i, ONE) + (ONE >> 1)) | 0;
    out[b + 2] = out[CH_CANDLE + Math.imul(n, 4) + i];
    out[b + 4] = out[b + 2] === CH_NONE ? 0 : 1;
  }
  for (let si = 0; si < 2; si++) {
    const side = si === 0 ? -1 : 1, b = CH_ASSAULT + Math.imul(si, CH_ASSAULT_WORDS);
    const target = assaultTarget(s, O_TACTICS, side), tg = min(target, OBJECTIVES - 1);
    const x = slotX(objectivePresent(s, O_TACTICS, tg) ? objectiveLane(s, O_TACTICS, tg) : 0);
    const half = (slotX(1) - slotX(0)) >> 1;
    chartPoint(st, rg, x, 0, p);
    out[b] = assaultPhase(s, O_TACTICS, side); out[b + 1] = target; out[b + 2] = p[0]; out[b + 3] = p[2];
    chartPoint(st, rg, (x - half) | 0, 0, p); out[b + 4] = p[0];
    chartPoint(st, rg, (x + half) | 0, 0, p); out[b + 5] = p[0];
  }
  return (CH_CANDLE + Math.imul(n, 5)) | 0;
}
