// WAR_TACTICS.md §4.14 THE CHART FIGHTS THE WAR - the three §0.1 trend probes, from the state only.
//
//     node tools/measure-trend.mjs [--core=DIR/src] [--seeds=1,2,3,4,5] [--ticks=3600]
//
// UP: from tick 600 to 1200 twelve samples 50 ticks apart raise the tape +0.5% in all (six green 10 s candles), then it is
// held (no more samples). Rows: from tick 900 every assault started is a bull assault; the bulls' mean push across all
// lanes exceeds the bears' by >= 12 m on >= 70% of ticks from 1200; no bear hull crosses the seam after 1200; from 900
// bear losses (tanks and men) per 60 s exceed bull losses by >= 30%, and the bears have fewer living tanks on >= 70% of
// ticks. DOWN is the mirror. SIDEWAYS: a sample every 300 ticks, candles alternating green and red of 5 bp for the whole
// run; rows: both sides mount assaults, the holder of at least one objective flips on >= 4 of 5 seeds, and neither side's
// mean push exceeds the other's by more than 4 m over the run.
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const SRC = arg('core', new URL('../src', import.meta.url).pathname);
const SEEDS = arg('seeds', '1,2,3,4,5').split(',').map(Number);
const TICKS = Number(arg('ticks', 3600));
const url = (rel) => pathToFileURL(join(SRC, rel)).href;
const { init, step, submitSample } = await import(url('sim.js'));
const L = await import(url('state.js'));
const T = await import(url('rules/tactics.js'));
const { frontlineZ } = await import(url('rules/frontline.js'));
const ONE = 65536, HX = 130 * ONE, HZ = 85 * ONE;
const base = (i) => L.O_UNITS + i * L.U_WORDS;
const sideOf = (i) => (((i >> 2) & 1) === 0 ? -1 : 1);
const P = (x) => (100 * x).toFixed(1) + '%';

function run(kind) {
  const out = { assaults: { '-1': 0, '1': 0 }, wrongSide: 0, gapOk: 0, gapTicks: 0, crossed: 0, loss: { '-1': 0, '1': 0 }, fewer: 0, fewerTicks: 0, flipSeeds: 0, pushSum: { '-1': 0, '1': 0 }, pushN: 0, trendAt: [], gapMean: 0 };
  const win = kind === 'up' ? -1 : kind === 'down' ? 1 : 0;      // the side the trend favours (bulls are side -1)
  const lose = -win;
  for (const seed of SEEDS) {
    const st = init(seed), s = st.i32;
    const open = st.tape[st.tape.length - 1], bp = Math.max(1, Math.floor(open / 10000));
    const was = { '-1': 0, '1': 0 }; const alive0 = new Map(); let flipped = false; const holders0 = [0, 1, 2].map(() => 0);
    let price = open;
    for (let t = 0; t < TICKS; t++) {
      if (kind !== 'side' && t >= 600 && t < 1200 && (t - 600) % 50 === 0) { price += (kind === 'up' ? 1 : -1) * Math.round(open * 0.005 / 12); submitSample(st, price); }
      if (kind === 'side' && t > 0 && t % 300 === 0) { const k = t / 300; price = open + ((Math.floor((k - 1) / 2) % 2 === 0) === (k % 2 === 1) ? 0 : 5 * bp); submitSample(st, price); }
      const aliveBefore = Array.from({ length: 96 }, (_, i) => s[base(i) + L.U_STATE] !== 0);
      const holdersBefore = [0, 1, 2].map((o) => T.objectiveHolder(s, L.O_TACTICS, o));
      step(st, 0, 0, 0, ONE, 0);
      const tick = s[L.O_TICK];
      if (t === 1200) out.trendAt.push(`${s[L.O_TACTICS + T.TAC_MARKET + T.MK_TREND]}/${s[L.O_TACTICS + T.TAC_MARKET + T.MK_STRENGTH]}`);
      for (const side of [-1, 1]) {
        const ph = T.assaultPhase(s, L.O_TACTICS, side);
        if (ph === T.ASSAULT_PUSH && was[side] !== T.ASSAULT_PUSH) { out.assaults[side]++; if (kind !== 'side' && tick >= 900 && side === lose) out.wrongSide++; }
        was[side] = ph;
      }
      for (let o = 0; o < 3; o++) { const h = T.objectiveHolder(s, L.O_TACTICS, o); if (holdersBefore[o] !== 0 && h !== holdersBefore[o]) flipped = true; }
      const mean = (side) => { let a = 0; for (let w = side < 0 ? 0 : 6; w < (side < 0 ? 6 : 12); w++) a += s[L.O_TACTICS + T.TAC_PUSH + w]; return a / 6 / ONE; };
      out.pushSum['-1'] += mean(-1); out.pushSum['1'] += mean(1); out.pushN++;
      if (kind !== 'side' && t >= 1200) {
        out.gapTicks++; const g = mean(win) - mean(lose); out.gapMean += g; if (g >= 12) out.gapOk++;
        for (let i = 0; i < 96; i += 4) if (s[base(i) + L.U_STATE] && sideOf(i) === lose && (s[base(i) + 1] - frontlineZ(st.tape, s[base(i)], HX, HZ)) * lose < 0) { out.crossed++; break; }
      }
      if (kind !== 'side' && t >= 900) {
        for (let i = 0; i < 96; i++) if (aliveBefore[i] && s[base(i) + L.U_STATE] === 0) out.loss[String(sideOf(i))]++;
        let tw = 0, tl = 0; for (let i = 0; i < 96; i += 4) if (s[base(i) + L.U_STATE]) { if (sideOf(i) === win) tw++; else tl++; }
        out.fewerTicks++; if (tl < tw) out.fewer++;
      }
    }
    if (flipped) out.flipSeeds++;
  }
  return out;
}

for (const kind of ['up', 'down', 'side']) {
  const o = run(kind);
  if (kind === 'side') {
    const d = Math.abs(o.pushSum['-1'] - o.pushSum['1']) / o.pushN;
    console.log(`SIDEWAYS  assaults bull ${o.assaults['-1']} bear ${o.assaults['1']} (both >= 1: ${o.assaults['-1'] > 0 && o.assaults['1'] > 0}); a holder flipped on ${o.flipSeeds} of ${SEEDS.length} seeds (>= 4); mean push bull ${(o.pushSum['-1'] / o.pushN).toFixed(2)} m, bear ${(o.pushSum['1'] / o.pushN).toFixed(2)} m, difference ${d.toFixed(2)} m (<= 4)`);
    continue;
  }
  const win = kind === 'up' ? 'bull' : 'bear', lose = kind === 'up' ? 'bear' : 'bull', wk = kind === 'up' ? '-1' : '1', lk = kind === 'up' ? '1' : '-1';
  const minutes = (TICKS - 900) / 3600 * SEEDS.length;
  console.log(`${kind.toUpperCase().padEnd(9)} trend word at tick 1200 (dir/strength) ${o.trendAt.join(' ')}`);
  console.log(`          assaults ${win} ${o.assaults[wk]}, ${lose} ${o.assaults[lk]}; ${lose} assaults started from tick 900: ${o.wrongSide} (row: 0)`);
  console.log(`          ${win} mean push - ${lose} >= 12 m on ${P(o.gapOk / o.gapTicks)} of ticks from 1200 (row >= 70%), mean gap ${(o.gapMean / o.gapTicks).toFixed(2)} m; ticks with a ${lose} hull across the seam after 1200: ${o.crossed} (row: 0)`);
  console.log(`          losses from 900 per 60 s (tanks and men, all seeds): ${lose} ${(o.loss[lk] / minutes).toFixed(1)}, ${win} ${(o.loss[wk] / minutes).toFixed(1)} -> ${lose}/${win} ${(o.loss[lk] / Math.max(1, o.loss[wk])).toFixed(2)} (row >= 1.30); ${lose} fewer living tanks on ${P(o.fewer / o.fewerTicks)} of ticks (row >= 70%)`);
}
