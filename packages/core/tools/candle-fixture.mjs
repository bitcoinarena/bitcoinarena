// The core's own candle words (src/rules/candles.js, `candleView`) and the candle layer's height at sample points, for
// CandleTerrain's EditMode tests: the mesh is tested against what the core stands the truck on (WAR_TACTICS.md §4.15,
// "the client's drawn height differs from candleHeight by more than 0.1 m" is a failure).
//
//   node tools/candle-fixture.mjs > ../../unity-proto/Assets/Tests/Fixtures/candle-words.txt
//
// Lines: `view NAME w0 w1 ...` and `h NAME x z height` (Q16.16), heights above the apron. Samples on each body's centre
// line and 1 cm inside each x-face, every 0.5 m (2 m after a sample) from 2 m before the body to 2 m after it.
import { init, submitSample, candleView, surfaceAt, terrainAt } from '../src/sim.js';
import * as L from '../src/state.js';
import * as T from '../src/rules/tactics.js';
import * as C from '../src/rules/candles.js';

const ONE = 65536, lines = [];
const put = (name, st, step) => {
  const v = new Int32Array(C.CV_TOTAL);
  candleView(st, v);
  lines.push(`view ${name} ${Array.from(v).join(' ')}`);
  for (let c = 0; c < C.CANDLES; c++) {
    const b = C.CV_FIRST + c * C.CV_WORDS, x0 = v[b], x1 = v[b + 1], z0 = v[b + 2], z1 = v[b + 3];
    for (const x of [(x0 + x1) >> 1, x0 + 655, x1 - 655])
      for (let z = z0 - 2 * ONE; z <= z1 + 2 * ONE; z += step)
        lines.push(`h ${name} ${x} ${z} ${(surfaceAt(st, x, z) - terrainAt(st, x, z)) | 0}`);
  }
};
let st = init(1);
put('open', st, ONE >> 1);
submitSample(st, st.i32[L.O_TACTICS + T.TAC_MARKET + T.MK_OPEN] + 3000);
put('one-sample', st, Math.imul(2, ONE));
process.stdout.write(lines.join('\n') + '\n');
