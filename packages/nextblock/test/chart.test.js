// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WAR_TACTICS.md §0.3: the HUD's one chart, as the core hands it to the page. GROUND is the minimap's window, ROUND
// the lead's; YOU, the gate, the objectives and the assault are core words through one mapping; reading it changes
// nothing.
import { xAtTape } from '../src/rules/frontline.js';
import { CANDLE_SLOT } from '../src/rules/candles.js';
import { GATE_X } from '../src/rules/gate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { init, step, teleport, submitSample, frontAt, scrollNow, HALF_X, HALF_Z } from '../src/sim.js';
import { hash } from '../src/state.js';
import * as L from '../src/state.js';
import * as T from '../src/rules/tactics.js';
import * as C from '../src/chart.js';

const ONE = 65536;
const view = (st, range) => { const o = new Int32Array(C.CH_WORDS); C.chartView(st, range, o); return o; };
const candle = (o, i) => Array.from(o.slice(C.CH_CANDLE + 4 * i, C.CH_CANDLE + 4 * i + 4));
/** THE STAIRCASE (§4.15, 2026-09-17 13:42): candle i of a series opens on the previous close (sample 2i - 1, its own first
 *  sample where there is none), closes on 2i + 1, and its high and low are over the three. */
const stair = (series, i, hasPrev = i > 0) => {
  const m = series[2 * i], c = series[2 * i + 1], o = hasPrev ? series[2 * i - 1] : m;
  return [o, Math.max(o, m, c), Math.min(o, m, c), c];
};

test('GROUND is the tape on the terrain: 32 staircase candles of two samples, the window its scale, the ground edge to edge', () => {
  const st = init(7), o = view(st, C.CHART_GROUND);
  assert.equal(o[C.CH_RANGE], C.CHART_GROUND);
  assert.equal(o[C.CH_CANDLES], 32);
  for (let i = 0; i < 32; i++) assert.deepEqual(candle(o, i), stair(st.tape, i), `candle ${i}`);
  assert.equal(o[C.CH_LO], Math.min(...st.tape));
  assert.equal(o[C.CH_HI], Math.max(...st.tape));
  // The candle field's first and last sample (§4.15 seam remap: the tape is laid over the candles, not the old +-130 m
  // map) are the chart's first and last sample: candle 0's open, candle 31's close.
  // Read through the scroll the chart stands at (§4.15 movement): at init one sample, half a slot.
  // The scrolled x is a whole Q16.16 metre off the slot grid, so the round trip x -> t may land one unit off: 1/65536 of
  // a candle, 0.09 mm (measured 16385 for 16384).
  const p = [0, 0, 0], sc = scrollNow(st);
  C.chartPoint(st, C.CHART_GROUND, xAtTape(0, 0, sc), 0, p); assert.ok(Math.abs(p[0] - ONE / 4) <= 1, `t ${p[0]}`); assert.equal(p[2], 1);
  C.chartPoint(st, C.CHART_GROUND, xAtTape(63 * ONE, 0, sc), 0, p); assert.ok(Math.abs(p[0] - (32 * ONE - ONE / 4)) <= 1, `t ${p[0]}`); assert.equal(p[2], 1);
  assert.equal(o[C.CH_WINDOW_FROM], ONE / 4);
  assert.equal(o[C.CH_WINDOW_TO], 32 * ONE - ONE / 4);
});

test('ROUND is the lead: from the open candle, one more staircase candle every two samples, the last close against the open', () => {
  const st = init(7);
  let o = view(st, C.CHART_ROUND);
  assert.equal(o[C.CH_CANDLES], 1);
  assert.equal(candle(o, 0)[3], o[C.CH_OPEN], 'the round starts on the open');
  const seededOpen = o[C.CH_OPEN], seededBefore = st.tape[62];
  const prices = [];
  for (let k = 0; k < 90; k++) { const p = seededOpen + ((k * 7919) % 4001) - 1500; prices.push(p); submitSample(st, p); }
  o = view(st, C.CHART_ROUND);
  assert.equal(o[C.CH_CANDLES], 1 + 45, '90 samples are 45 candles after the open candle');
  // THE FIRST LIVE PRICE CONTINUES THE CHART (2026-09-17 16:42): the seeded tape, the open with it, is moved onto
  // the first sample's level, so the open candle ends where the first price begins.
  const d = prices[0] - seededOpen, open = seededOpen + d;
  assert.equal(o[C.CH_OPEN], open, 'the open did not move onto the first live price');
  const round = [seededBefore + d, open, ...prices];   // what the round saw, tape and memory together
  assert.equal(st.roundTape.length, round.length);
  for (let i = 0; i < o[C.CH_CANDLES]; i++) assert.deepEqual(candle(o, i), stair(round, i), `round candle ${i}`);
  const fronts = Array.from(o.slice(C.CH_CANDLE + 4 * o[C.CH_CANDLES], C.CH_CANDLE + 5 * o[C.CH_CANDLES])).filter((v) => v !== C.CH_NONE);
  assert.ok(fronts.length > 0);
  assert.equal(o[C.CH_LO], Math.min(...round, ...fronts), 'ROUND scales to its candles and the seam over them');
  assert.equal(o[C.CH_HI], Math.max(...round, ...fronts));
  assert.equal(o[C.CH_HIGH_P], Math.max(...round), 'HIGH is the highest candle');
  assert.equal(o[C.CH_LOW_P], Math.min(...round), 'LOW is the lowest candle');
  const hiAt = round.indexOf(Math.max(...round)) >> 1, loAt = round.indexOf(Math.min(...round)) >> 1;
  assert.equal(o[C.CH_HIGH_T], hiAt * ONE + ONE / 2);
  assert.equal(o[C.CH_LOW_T], loAt * ONE + ONE / 2);
  const last = prices[prices.length - 1];
  assert.equal(o[C.CH_LAST], last);
  assert.equal(o[C.CH_LEAD], Math.sign(last - open), 'the header lead is the core word');
  assert.equal(o[C.CH_LEAD], st.i32[L.O_TACTICS + T.TAC_MARKET + T.MK_LEAD]);
  assert.equal(o[C.CH_LEAD_BP], Math.trunc((last - open) / Math.trunc(open / 10000)) | 0);
  // GROUND at the same moment is the last 32 candles of the same series, and they are ROUND's last 32.
  const g = view(st, C.CHART_GROUND);
  assert.equal(g[C.CH_CANDLES], 32);
  for (let i = 0; i < 32; i++) assert.deepEqual(candle(g, i), candle(o, o[C.CH_CANDLES] - 32 + i), `ground ${i} = round ${o[C.CH_CANDLES] - 32 + i}`);
  assert.notEqual(o[C.CH_LO] === g[C.CH_LO] && o[C.CH_HI] === g[C.CH_HI] && o[C.CH_CANDLES] === 32, true, 'the two ranges are different windows');
});

test('YOU is the core truck: parked it stays, driven it moves right on the chart as the truck moves +x', () => {
  const st = init(11), s = st.i32, p = [0, 0, 0];
  const you = () => { const o = view(st, C.CHART_GROUND); return [o[C.CH_YOU_T], o[C.CH_YOU_P], o[C.CH_YOU_ON]]; };
  const at = you();
  C.chartPoint(st, C.CHART_GROUND, s[L.O_TRUCK + L.T_X], s[L.O_TRUCK + L.T_Z], p);
  assert.deepEqual(at, p);
  for (let t = 0; t < 120; t++) step(st, 0, 0, ONE, ONE, 0);
  // Parked, the chart slides under it (§4.15 movement): 120 ticks are 0.4 of a sample, 0.2 of a candle, toward the new.
  const parked = you();
  assert.deepEqual([parked[0] - at[0], parked[1], parked[2]], [Math.round(0.2 * ONE), at[1], at[2]], 'parked');
  for (let t = 0; t < 600; t++) step(st, ONE, 0, 0, 0, 0);
  const moved = you();
  assert.ok(s[L.O_TRUCK + L.T_X] > -6579814 + 5 * ONE, `the truck drove (x ${s[L.O_TRUCK + L.T_X] / ONE})`);
  assert.ok(moved[0] > at[0], `YOU moved right: t ${at[0] / ONE} -> ${moved[0] / ONE}`);
  C.chartPoint(st, C.CHART_GROUND, s[L.O_TRUCK + L.T_X], s[L.O_TRUCK + L.T_Z], p);
  assert.deepEqual(moved, p, 'driven, still the core position through the mapping');
  // z is price: the same x, higher z, a higher price; z on the seam reads the seam's price.
  teleport(st, 0, 0, 16384); const lowP = you()[1];
  teleport(st, 0, 20 * ONE, 16384); assert.ok(you()[1] > lowP);
  const o = view(st, C.CHART_GROUND), i = 16;
  const x = xAtTape((2 * i + 0.5) * ONE, 0, scrollNow(st));   // candle 16's middle on the candle field, as it stands now
  C.chartPoint(st, C.CHART_GROUND, x, frontAt(st, x), p);
  assert.ok(Math.abs(p[1] - o[C.CH_CANDLE + 4 * 32 + i]) <= 2, 'the seam through the mapping is the seam line drawn');
  assert.ok(Math.abs(HALF_Z) > 0);
});

test('GATE is the core gate, the objectives and the assault the core words, and reading the chart changes no state', () => {
  const st = init(3), s = st.i32;
  let seen = 0;
  for (let t = 0; t < 4800; t++) {
    step(st, 0, 0, ONE, ONE, 0);
    if (t % 60) continue;
    const before = hash(st);
    const o = view(st, C.CHART_GROUND);
    view(st, C.CHART_ROUND);
    assert.deepEqual(hash(st), before, 'a chart read wrote state');
    for (const [si, side] of [[0, -1], [1, 1]]) {
      const b = C.CH_ASSAULT + si * C.CH_ASSAULT_WORDS, ph = T.assaultPhase(s, L.O_TACTICS, side);
      assert.equal(o[b], ph); assert.equal(o[b + 1], T.assaultTarget(s, L.O_TACTICS, side));
      assert.ok(o[b + 4] < o[b + 2] && o[b + 2] < o[b + 5], 'the assault column is the lane around its centre');
      if (ph !== T.ASSAULT_IDLE) seen++;
    }
    for (let k = 0; k < 3; k++) assert.equal(o[C.CH_OBJ + k * C.CH_OBJ_WORDS + 3], T.objectiveHolder(s, L.O_TACTICS, k));
  }
  assert.ok(seen > 0, 'no assault ran in 80 s, so the assault mark was never checked');
  const o = view(st, C.CHART_GROUND), p = [0, 0, 0];
  // THE GATE'S OWN X, not the 114 it used to sit at: the delivery line follows the miner (gate.js GATE_X), and the
  // miner moved east on 2026-09-19 so the building would stop standing on the chart.
  C.chartPoint(st, C.CHART_GROUND, GATE_X, 0, p);
  assert.equal(o[C.CH_GATE_T], p[0]);
  // §4.15 G1: the chart is the candle field and the gate stands past its last candle - off the chart, its true t
  // 15.170 of a candle past the 32nd (the HUD pins GATE › at the right edge; ChartHudTests). The number has moved
  // twice on purpose and each time the gate or the chart moved, never the rule: 0.97 while the field ran to 108.4 m
  // and the gate sat at 114; 4.632 when ruling B was refitted to the miner's door and a candle became 5.181 m; and
  // 15.170 now that the world grew east and the delivery line went with the miner to 168.6 m. The identity above it
  // is the test: t is the gate's own distance past the newest candle in candles, and the band is what that
  // arithmetic gives on this world.
  assert.equal(o[C.CH_GATE_ON], 0, 'the gate past the last candle is on the chart');
  assert.equal(p[2], 0);
  // The chart has scrolled (§4.15): 4800 ticks with no sample hold the slide at two samples, one candle further.
  const sc = scrollNow(st), past = (o[C.CH_GATE_T] - o[C.CH_CANDLES] * ONE) / ONE;
  assert.equal(sc, 2 * ONE, 'the slide holds at two samples when no sample comes');
  assert.ok(Math.abs(past - (GATE_X - (xAtTape(63 * ONE, 0, sc) + (CANDLE_SLOT >> 2))) / CANDLE_SLOT) < 1e-3 && past - 1 > 15.15 && past - 1 < 15.19,
    `the gate is ${past.toFixed(4)} of a candle past the last`);
});

// THE SIX DOTS ARE THE SIX CANDLES ABOVE THEM (2026-09-19 21:39, hud-sideways-five-red-2139.png: the HUD
// printed SIDEWAYS over five red candles). §4.14 reads "the colour of the last six FINISHED candles" and a candle is
// what §4.15 draws - two samples, opening on the previous candle's close. The trend read one sample of each body and
// dropped the other, so it graded half the candle the player was looking at: a body of $2.44 to $4.88 at $81,339 was
// red on the screen and a doji to the war.
//
// The test is the identity, not a number: every dot equals the colour of the drawn candle it sits under, and the
// trend word equals the net of those same six. It holds at every price and both sample parities, so it cannot be
// satisfied by moving the doji band.
test('the trend and its six dots are the colours of the six finished candles the chart draws (§4.14, §4.15)', () => {
  for (const seed of [1, 2, 3]) {
    const st = init(seed);
    // walk the tape through both parities, and through a fall steep enough to colour every body
    for (let k = 0; k < 9; k++) {
      const s = st.i32;
      for (const range of [C.CHART_GROUND, C.CHART_ROUND]) {
        const o = view(st, range), n = o[C.CH_CANDLES], count = o[C.CH_SAMPLES];
        // the newest FINISHED drawn candle: the newest slot unless an odd sample count leaves it forming
        const newest = n - 1 - (count & 1);
        // ROUND starts one candle wide and grows; there is nothing to compare until it holds six finished ones with
        // a candle before them (its slot 0 opens on its own first sample, having no previous close).
        if (newest - 5 < 1) { assert.equal(range, C.CHART_ROUND, 'GROUND has fewer than six finished candles'); continue; }
        let net = 0;
        for (let c = 0; c < 6; c++) {
          const drawn = candle(o, newest - c);            // open, high, low, close
          const colour = T.candleColour(drawn[0], drawn[3]);
          const dot = (o[C.CH_DOTS] >> (c * 2)) & 3;
          assert.equal(dot, colour > 0 ? 1 : colour < 0 ? 2 : 0,
            `seed ${seed} step ${k} ${range === C.CHART_GROUND ? 'GROUND' : 'ROUND'}: dot ${c} is ${dot} and the candle it sits under is ${colour}`);
          net += colour;
        }
        const a = Math.abs(net);
        assert.equal(o[C.CH_TREND], a < 2 ? 0 : net > 0 ? 1 : -1, `seed ${seed} step ${k}: the trend word is not the net of the six drawn candles`);
        assert.equal(o[C.CH_STRENGTH], a < 2 ? 0 : a < 4 ? 1 : a < 6 ? 2 : 3, `seed ${seed} step ${k}: the strength is not the net's`);
      }
      // a fall of about $4 a candle - inside the band where the old reading said SIDEWAYS over red bodies
      submitSample(st, (st.tape[st.tape.length - 1] - 512) | 0);
      for (let t = 0; t < 300; t++) step(st, ONE, 0, 0, 0, 0);
    }
  }
});
