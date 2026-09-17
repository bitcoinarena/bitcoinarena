// WAR_TACTICS.md §0.3: the HUD's one chart, as the core hands it to the page. GROUND is the minimap's window, ROUND
// the lead's; YOU, the gate, the objectives and the assault are core words through one mapping; reading it changes
// nothing.
import { xAtTape } from '../src/rules/frontline.js';
import { CANDLE_SLOT } from '../src/rules/candles.js';
import { GATE_X } from '../src/rules/gate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { init, step, teleport, submitSample, frontAt, HALF_X, HALF_Z } from '../src/sim.js';
import { hash } from '../src/state.js';
import * as L from '../src/state.js';
import * as T from '../src/rules/tactics.js';
import * as C from '../src/chart.js';

const ONE = 65536;
const view = (st, range) => { const o = new Int32Array(C.CH_WORDS); C.chartView(st, range, o); return o; };
const candle = (o, i) => Array.from(o.slice(C.CH_CANDLE + 4 * i, C.CH_CANDLE + 4 * i + 4));

test('GROUND is the tape on the terrain: 32 candles of two samples, the window its scale, the ground edge to edge', () => {
  const st = init(7), o = view(st, C.CHART_GROUND);
  assert.equal(o[C.CH_RANGE], C.CHART_GROUND);
  assert.equal(o[C.CH_CANDLES], 32);
  for (let i = 0; i < 32; i++) {
    const a = st.tape[2 * i], b = st.tape[2 * i + 1];
    assert.deepEqual(candle(o, i), [a, Math.max(a, b), Math.min(a, b), b], `candle ${i}`);
  }
  assert.equal(o[C.CH_LO], Math.min(...st.tape));
  assert.equal(o[C.CH_HI], Math.max(...st.tape));
  // The candle field's first and last sample (§4.15 seam remap: the tape is laid over the candles, not the old +-130 m
  // map) are the chart's first and last sample: candle 0's open, candle 31's close.
  const p = [0, 0, 0];
  C.chartPoint(st, C.CHART_GROUND, xAtTape(0, 0), 0, p); assert.equal(p[0], ONE / 4); assert.equal(p[2], 1);
  C.chartPoint(st, C.CHART_GROUND, xAtTape(63 * ONE, 0), 0, p); assert.equal(p[0], 32 * ONE - ONE / 4); assert.equal(p[2], 1);
  assert.equal(o[C.CH_WINDOW_FROM], ONE / 4);
  assert.equal(o[C.CH_WINDOW_TO], 32 * ONE - ONE / 4);
});

test('ROUND is the lead: from the open candle, one more candle every two samples, the last close against the open', () => {
  const st = init(7);
  let o = view(st, C.CHART_ROUND);
  assert.equal(o[C.CH_CANDLES], 1);
  assert.equal(candle(o, 0)[3], o[C.CH_OPEN], 'the round starts on the open');
  const open = o[C.CH_OPEN], before = st.tape[62];
  const prices = [];
  for (let k = 0; k < 90; k++) { const p = open + ((k * 7919) % 4001) - 1500; prices.push(p); submitSample(st, p); }
  o = view(st, C.CHART_ROUND);
  assert.equal(o[C.CH_CANDLES], 1 + 45, '90 samples are 45 candles after the open candle');
  const round = [before, open, ...prices];   // what the round saw, tape and memory together
  assert.equal(st.roundTape.length, round.length);
  for (let i = 0; i < o[C.CH_CANDLES]; i++) {
    const a = round[2 * i], b = round[2 * i + 1];
    assert.deepEqual(candle(o, i), [a, Math.max(a, b), Math.min(a, b), b], `round candle ${i}`);
  }
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
  assert.deepEqual(you(), at, 'parked');
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
  const x = xAtTape((2 * i + 0.5) * ONE, 0);          // candle 16's middle on the candle field
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
  C.chartPoint(st, C.CHART_GROUND, 114 * ONE, 0, p);
  assert.equal(o[C.CH_GATE_T], p[0]);
  // §4.15 G1: the chart is the candle field and the gate at x 114 stands past its last candle - off the chart, its true t
  // 0.97 of a candle past the 32nd (the HUD pins GATE › at the right edge; ChartHudTests).
  assert.equal(o[C.CH_GATE_ON], 0, 'the gate past the last candle is on the chart');
  assert.equal(p[2], 0);
  const past = (o[C.CH_GATE_T] - o[C.CH_CANDLES] * ONE) / ONE;
  assert.ok(Math.abs(past - (GATE_X - (xAtTape(63 * ONE, 0) + (CANDLE_SLOT >> 2))) / CANDLE_SLOT) < 1e-3 && past > 0.97 && past < 0.98,
    `the gate is ${past.toFixed(4)} of a candle past the last`);
});
