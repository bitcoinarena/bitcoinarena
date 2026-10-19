// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SIX TREND DOTS AGAINST THE CANDLES ON THE SAME HUD (2026-09-19 21:39,
// hud-sideways-five-red-2139.png: "SIDEWAYS is wrong - last five candles are RED").
//
// §4.14 reads "the colour of the last SIX FINISHED candles". A candle is what §4.15 draws, and this prints the two
// readings for one tape: the body the chart draws in each slot, and the body the core scores for the trend. If they
// are not the same body the dots cannot match the chart, and no doji band can fix it.
//
// It scores through the core's own `trendCandle`, not a copy of the indexing, so the table is what ships.
//
//   node packages/nextblock/tools/measure-trend-vs-chart.mjs
import { CANDLES, CL_WORDS } from '../src/rules/candles.js';
import { SAMPLES } from '../src/rules/frontline.js';
import { candleColour, trendCandle, trendEnd } from '../src/rules/tactics.js';

// THE TAPE IS DOLLARS x 256 (chart.js CHART_UNIT), not Q16.16: §4.14's worked example only comes out at that scale -
// the band `open * 3 / 100000` is 576 units at $75,000, and 576 / 256 is the $2.25 the section prints.
const UNIT = 256;
const price = (dollars) => Math.round(dollars * UNIT);
const d = (q) => q / UNIT;
const LEVEL = 81339;                                   // the shot's own price
const band = Math.floor((LEVEL * UNIT * 3) / 100000);
const word = (n) => (Math.abs(n) < 2 ? 'SIDEWAYS' : `${n > 0 ? 'UP' : 'DOWN'} ${Math.abs(n) < 4 ? 1 : Math.abs(n) < 6 ? 2 : 3}`);
const name = (v) => (v > 0 ? 'green' : v < 0 ? 'red  ' : 'doji ');

// A tape falling `perCandle` dollars every 10 s candle, which is `perCandle / 2` a sample.
const tapeFalling = (perCandle) => {
  const t = new Int32Array(SAMPLES);
  for (let k = 0; k < SAMPLES; k++) t[k] = price(LEVEL + ((SAMPLES - 1 - k) * perCandle) / 2);
  return t;
};

// The body the chart draws for the slot that closes on tape index `close` (§4.15's staircase, chart.js and
// candles.js both: open = the previous candle's close, two samples back).
const drawn = (tape, close) => [tape[close - 2], tape[close]];

// WHAT THE CORE SCORED UNTIL 21:39: the open taken one sample back, not two - the sample in the MIDDLE of the body,
// the one that draws the wick. Kept here so the fault's size is a measured column and not a sentence.
const wasScored = (tape, end, c) => candleColour(tape[end - c * 2 - 1], tape[end - c * 2]);

console.log(`THE DRAWN CANDLE AGAINST THE SCORED CANDLE - a chart falling $5.20 a candle at $${LEVEL.toLocaleString()}`);
for (const taken of [0, 1]) {
  const tape = tapeFalling(5.2);
  const end = trendEnd(tape, taken);
  console.log(`\n  ${taken & 1 ? 'ODD' : 'EVEN'} sample count - the newest slot is ${taken & 1 ? 'FORMING' : 'FINISHED'}; the six finished candles, newest first`);
  console.log('     back   drawn open   drawn close     body $   drawn  |  scored  was');
  let netDrawn = 0, netScored = 0, netWas = 0;
  for (let c = 0; c < 6; c++) {
    const [o, cl] = drawn(tape, end - c * 2);
    const dc = candleColour(o, cl), sc = trendCandle(tape, end, c), wc = wasScored(tape, end, c);
    netDrawn += dc; netScored += sc; netWas += wc;
    console.log(`     ${String(c).padStart(4)}   ${d(o).toFixed(2).padStart(10)}   ${d(cl).toFixed(2).padStart(11)}` +
                `${d(cl - o).toFixed(2).padStart(11)}   ${name(dc)}  |  ${name(sc)}  ${name(wc)}`);
  }
  console.log(`     net drawn ${String(netDrawn).padStart(3)} -> ${word(netDrawn)}     net scored ${String(netScored).padStart(3)} -> ${word(netScored)}     was ${String(netWas).padStart(3)} -> ${word(netWas)}`);
}

// HOW WIDE THE FAULT WAS. Scored half a body, a candle read doji until its DRAWN body was twice the band.
console.log(`\nTHE DISAGREEMENT BAND, doji band $${d(band).toFixed(2)} (0.3 bp of $${LEVEL.toLocaleString()})`);
console.log('   $ a drawn candle   the chart shows   the trend says   it said before 21:39');
for (const per of [1.0, 2.0, 2.5, 3.0, 4.0, 4.8, 5.2, 6.0, 10.0]) {
  const tape = tapeFalling(per), end = trendEnd(tape, 0);
  let nd = 0, ns = 0, nw = 0;
  for (let c = 0; c < 6; c++) {
    const [o, cl] = drawn(tape, end - c * 2);
    nd += candleColour(o, cl); ns += trendCandle(tape, end, c); nw += wasScored(tape, end, c);
  }
  const flag = word(nd) === word(nw) ? '' : '   <- DISAGREED';
  console.log(`   ${per.toFixed(2).padStart(16)}   ${word(nd).padStart(15)}   ${word(ns).padStart(14)}   ${word(nw).padStart(19)}${flag}`);
}
console.log(`\n  A drawn body of $${d(band).toFixed(2)} to $${d(band * 2).toFixed(2)} is RED on the screen. Scored as half a body it was a DOJI, so five`);
console.log(`  red candles made net 0 and the HUD printed SIDEWAYS. The band did not move; the candle did.`);
