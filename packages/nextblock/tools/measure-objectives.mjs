// WAR_TACTICS.md §4.11 OBJECTIVES: the core's three objective lanes against the chart's HIGH, LOW and OPEN, read from the
// state and the core's own chart view only (kanban #29, step 1 - nothing here changes a rule).
//
//     node tools/measure-objectives.mjs [--core=DIR/src] [--seeds=1,2,3,4,5] [--ticks=3600]
//
// The chart moves: one deterministic sample every 300 ticks (5 s, as a round's tape), a walk of whole basis points around
// the open, hashed from (seed, sample). On every sample tick: the core's objective lanes (objectiveLane 0, 1, 2) and the
// lanes of the ground window's HIGH candle (highest high), LOW candle (lowest low) and newest candle crossing the open
// (absent when none), each candle placed where chart.js places its seam - xAtTape of its centre - and laned to the
// nearest of the 7 slots. And per lane, the highest push a team reached there with no assault on its side and its side's
// trend not with it (the lane's own ceiling, §4.11's "24 everywhere" against the old RIDGE cap of 16).
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const SRC = arg('core', new URL('../src', import.meta.url).pathname);
const SEEDS = arg('seeds', '1,2,3,4,5').split(',').map(Number);
const TICKS = Number(arg('ticks', 3600));
const url = (rel) => pathToFileURL(join(SRC, rel)).href;
const { init, step, submitSample, scrollNow } = await import(url('sim.js'));
const L = await import(url('state.js'));
const T = await import(url('rules/tactics.js'));
const F = await import(url('rules/frontline.js'));
const C = await import(url('chart.js'));
const ONE = 65536, SLOTS = 7;
const laneOfX = (x) => { let best = 0; for (let l = 1; l < SLOTS; l++) if (Math.abs(T.slotX(l) - x) < Math.abs(T.slotX(best) - x)) best = l; return best; };
const mixh = (a, b) => { let h = (Math.imul(a, 0x9e3779b1) ^ Math.imul(b + 0x7f4a7c15, 0x85ebca77)) >>> 0; h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d) >>> 0; h ^= h >>> 12; return h; };

/** HIGH, LOW, OPEN of the ground window as lanes (OPEN null when no candle crosses the open). */
function chartLanes(st) {
  const out = new Int32Array(C.CH_WORDS);
  C.chartView(st, C.CHART_GROUND, out);
  const n = out[C.CH_CANDLES], first = out[C.CH_FIRST], open = out[C.CH_OPEN];
  const L_ = (st.i32[L.O_TACTICS + T.TAC_MARKET + T.MK_SAMPLES] + 2) | 0, count = st.i32[L.O_TACTICS + T.TAC_MARKET + T.MK_SAMPLES];
  let hi = null, lo = null, op = null;
  for (let i = 0; i < n; i++) {
    const k = first + i, a = 2 * k;
    const aq = (Math.imul(a, ONE) + (ONE >> 1) - Math.imul(L_ - F.SAMPLES, ONE)) | 0;
    if (aq < 0 || aq > Math.imul(F.SAMPLES - 1, ONE)) continue;               // not on the ground
    const x = F.xAtTape(aq, count, scrollNow(st)), b = C.CH_CANDLE + 4 * i;
    const cHi = out[b + 1], cLo = out[b + 2];
    if (!hi || cHi > hi.p) hi = { p: cHi, lane: laneOfX(x), k };
    if (!lo || cLo < lo.p) lo = { p: cLo, lane: laneOfX(x), k };
    if (cLo <= open && open <= cHi) op = { lane: laneOfX(x), k };              // the newest crossing wins (ascending k)
  }
  return { high: hi && hi.lane, low: lo && lo.lane, open: op ? op.lane : null };
}

const rows = [];
let samplesAll = 0, highSame = 0, lowSame = 0, openSame = 0, openPresent = 0, coreMoves = 0;
const quietMax = Array.from({ length: SLOTS }, () => 0);   // over all seeds, per lane: the ridge lane reported apart
let ridgeQuietMax = 0, otherObjQuietMax = 0, nonObjQuietMax = 0;
for (const seed of SEEDS) {
  const st = init(seed), s = st.i32, open = s[L.O_TACTICS + T.TAC_MARKET + T.MK_OPEN], bp = Math.max(1, Math.floor(open / 10000));
  let p = open, prevCore = null, per = { samples: 0, high: 0, low: 0, open: 0, openPresent: 0, coreLaneSets: new Set(), ridgeMax: 0 };
  for (let t = 1; t <= TICKS; t++) {
    let sampled = false;
    if (t % 300 === 0) { p += ((mixh(seed, t / 300) % 17) - 8) * bp; submitSample(st, p); sampled = true; }
    step(st, 0, 0, 0, ONE, 0);
    const core = [0, 1, 2].map((o) => T.objectiveLane(s, L.O_TACTICS, o));
    for (let w = 0; w < 12; w++) {
      const side = w < 6 ? -1 : 1, slot = s[L.O_TACTICS + T.TAC_SLOT + w], push = s[L.O_TACTICS + T.TAC_PUSH + w];
      if (T.assaultPhase(s, L.O_TACTICS, side) !== T.ASSAULT_IDLE || T.trendFor(s, L.O_TACTICS, side) > 0) continue;
      if (slot === core[(T.OBJ_RIDGE ?? T.OBJ_HIGH)]) { ridgeQuietMax = Math.max(ridgeQuietMax, push); per.ridgeMax = Math.max(per.ridgeMax, push); }
      else if (core.includes(slot)) otherObjQuietMax = Math.max(otherObjQuietMax, push);
      else nonObjQuietMax = Math.max(nonObjQuietMax, push);
    }
    if (!sampled) continue;
    const ch = chartLanes(st);
    per.samples++; samplesAll++;
    per.coreLaneSets.add(core.join(','));
    if (prevCore && prevCore !== core.join(',')) coreMoves++;
    prevCore = core.join(',');
    if (ch.high === core[0]) { per.high++; highSame++; }
    if (ch.low === core[1]) { per.low++; lowSame++; }
    if (ch.open !== null) { per.openPresent++; openPresent++; if (ch.open === core[2]) { per.open++; openSame++; } }
    if (seed === SEEDS[0] && per.samples <= 12) rows.push(`seed ${seed} t=${(t / 60).toFixed(0)}s core RIDGE/HOLLOW/GAP lanes ${core.join('/')} | chart HIGH ${ch.high} LOW ${ch.low} OPEN ${ch.open === null ? '-' : ch.open}`);
  }
  console.log(`seed ${seed}: ${per.samples} sample ticks; core lane sets seen ${[...per.coreLaneSets].join(' ; ')}; HIGH on RIDGE's lane ${per.high}/${per.samples}, LOW on HOLLOW's ${per.low}/${per.samples}, OPEN present ${per.openPresent}/${per.samples} and on GAP's lane ${per.open}/${per.openPresent}; quiet max push on RIDGE's lane ${(per.ridgeMax / ONE).toFixed(1)} m`);
}
console.log(rows.join('\n'));
console.log(`ALL: ${samplesAll} sample ticks; core objective lanes changed between sample ticks ${coreMoves} times; chart HIGH on RIDGE's lane ${highSame} (${(100 * highSame / samplesAll).toFixed(0)}%), LOW on HOLLOW's ${lowSame} (${(100 * lowSame / samplesAll).toFixed(0)}%), OPEN present ${openPresent} and on GAP's ${openSame}`);
console.log(`quiet max push (no assault, trend not with the side): RIDGE's lane ${(ridgeQuietMax / ONE).toFixed(1)} m, the other two objective lanes ${(otherObjQuietMax / ONE).toFixed(1)} m, other lanes ${(nonObjQuietMax / ONE).toFixed(1)} m`);
