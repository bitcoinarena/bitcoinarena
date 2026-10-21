// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// The core's own candle words (src/rules/candles.js, `candleView`) and the candle layer's height at sample points, for
// CandleTerrain's EditMode tests: the mesh is tested against what the core stands the truck on (WAR_TACTICS.md §4.15,
// "the client's drawn height differs from candleHeight by more than 0.1 m" is a failure).
//
//   node tools/candle-fixture.mjs > unity/Assets/Tests/Fixtures/candle-words.txt
//
// Lines: `view NAME w0 w1 ...` and `h NAME x z height` (Q16.16), heights above the apron. Samples on each body's centre
// line and 1 cm inside each x-face, every 0.5 m (2 m after a sample) from 2 m before the body to 2 m after it.
import { init, step, submitSample, candleView, surfaceAt, terrainAt } from '../src/sim.js';
import * as L from '../src/state.js';
import * as T from '../src/rules/tactics.js';
import * as C from '../src/rules/candles.js';

const ONE = 65536, lines = [];
const put = (name, st, step) => {
  const v = new Int32Array(C.CV_TOTAL);
  candleView(st, v);
  lines.push(`view ${name} ${Array.from(v).join(' ')}`);
  for (let c = 0; c < C.CANDLES; c++) {
    // the view's slots are unshifted; the world stands them CV_SHIFT toward -x (the scroll)
    const sh = v[C.CV_SHIFT], b = C.CV_FIRST + c * C.CV_WORDS, x0 = v[b] - sh, x1 = v[b + 1] - sh, z0 = v[b + 2], z1 = v[b + 3];
    for (const x of [(x0 + x1) >> 1, x0 + 655, x1 - 655])
      for (let z = z0 - 2 * ONE; z <= z1 + 2 * ONE; z += step)
        lines.push(`h ${name} ${x} ${z} ${(surfaceAt(st, x, z) - terrainAt(st, x, z)) | 0}`);
  }
};
// A QUARTER-METRE STEP, not half (2026-09-19). Ruling B refitted to the miner's door shortened the field from
// 184.2 m to 165.8 m and the tape now lands on different slots, so the bodies are shorter: at 0.5 m the fixture
// dropped from 7238 sample lines to 3821 and the EditMode counts (a thousand samples, five hundred inside a body,
// a hundred on a plateau) no longer had the points to make. The density is the fixture's business - what the tests
// assert is the drawn height against the core's - so both views step 0.25 m and the counts come back (open: 138
// plateau of 6039 samples at 0.25 m, worst 0.0002 m against the core; one-sample had 34 at 1 m).
let st = init(1);
put('open', st, ONE >> 2);
submitSample(st, st.i32[L.O_TACTICS + T.TAC_MARKET + T.MK_OPEN] + 3000);
// half a sample on: the chart has slid a quarter slot and the forming candle has grown half its glide (§4.15 movement)
for (let t = 0; t < 150; t++) step(st, 0, 0, 0, 0, 1);
put('one-sample', st, ONE >> 2);
process.stdout.write(lines.join('\n') + '\n');
