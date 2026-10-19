// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// The core's own chart words (src/chart.js) for the Unity painter's EditMode tests: the painter is tested on what the
// core hands a page, not on numbers a test made up.
//
//   node tools/chart-fixture.mjs > ../../unity-proto/Assets/Tests/Fixtures/chart-words.txt
import { init, step, submitSample, teleport, bayZ, START_X } from '../src/sim.js';
import * as L from '../src/state.js';
import * as T from '../src/rules/tactics.js';
import * as C from '../src/chart.js';

const ONE = 65536;
const lines = [];
const put = (name, st, range) => {
  const o = new Int32Array(C.CH_WORDS), n = C.chartView(st, range, o);
  lines.push(`${name} ${Array.from(o.slice(0, n)).join(' ')}`);
};

let st = init(7);
put('ground-open', st, C.CHART_GROUND);
put('round-open', st, C.CHART_ROUND);
// Driven ONTO the candle field (§4.15 G1): from seed 7's bay the truck meets candle 0's face before the field and YOU
// would still be the pre-chart pin; bay 23's lane (z 78.2) is past the candles, so 10 s at full throttle reach the field.
teleport(st, START_X, bayZ(23), 16384);
for (let t = 0; t < 600; t++) step(st, ONE, 0, 0, 0, 0);
put('ground-driven', st, C.CHART_GROUND);
const open = st.i32[L.O_TACTICS + T.TAC_MARKET + T.MK_OPEN];
for (let k = 0; k < 90; k++) submitSample(st, open + ((k * 7919) % 4001) - 1500);
put('ground-90', st, C.CHART_GROUND);
put('round-90', st, C.CHART_ROUND);

st = init(3);
for (let t = 0; t < 20000; t++) {
  step(st, 0, 0, ONE, ONE, 0);
  if (T.assaultPhase(st.i32, L.O_TACTICS, 1) === T.ASSAULT_PUSH || T.assaultPhase(st.i32, L.O_TACTICS, -1) === T.ASSAULT_PUSH) break;
}
put('ground-assault', st, C.CHART_GROUND);
process.stdout.write(lines.join('\n') + '\n');
