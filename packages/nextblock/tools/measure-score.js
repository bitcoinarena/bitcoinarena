// (n) half 2: does the core's run score equal the old game's, to the integer?
//
// The old path is `RunScore.cs:95-106`:
//   Projected = Mathf.RoundToInt(1000f * Exposure * TimeFactor * CargoFactor)
//   Exposure   = Clamp01(_exposure / 190)
//   TimeFactor = _elapsed <= 0.01 ? 1.5 : Clamp(65 / _elapsed, 0.25, 1.5)
//   CargoFactor= Clamp01(bay.Fill)
// The core path is `scoreOf(exposure, ticks, cargo)` in `rules/score.js`.
//
// READ-ONLY. Replays each golden vector, reads the exposure, elapsed and cargo
// the core actually holds, and puts the old formula on THOSE numbers rather
// than on the decimals they were typed as - feeding "0.4" to one side and
// 26214/65536 to the other is the not-a-pair trap this item keeps setting, and
// it accounts for every disagreement but two.
import { readFileSync } from 'node:fs';
import { init, step } from '../src/sim.js';
import { O_SCORE, S_EXPOSURE, S_ELAPSED, S_CARGO, S_DELIVERED, O_TRUCK, T_X } from '../src/state.js';
import { scoreOf, EXPOSURE_REFERENCE, REFERENCE_TICKS } from '../src/rules/score.js';

const ONE = 65536;
const REF_SECONDS = REFERENCE_TICKS / 60;

/** `RunScore.cs:95-106`, in floating point, on whatever it is handed. */
const oldGame = (exposure, ticks, cargo) => {
  const E = Math.min(1, Math.max(0, exposure / Math.max(0.01, 190)));
  const secs = ticks / 60;
  const T = secs <= 0.01 ? 1.5 : Math.min(1.5, Math.max(0.25, REF_SECONDS / secs));
  const C = Math.min(1, Math.max(0, cargo));
  return Math.round(1000 * E * T * C);
};

const row = (name, st, metres) => {
  const s = st.i32;
  const exp = s[O_SCORE + S_EXPOSURE], tk = s[O_SCORE + S_ELAPSED], cg = s[O_SCORE + S_CARGO];
  const core = scoreOf(exp, tk, cg);
  const old = oldGame(exp / ONE, tk, cg / ONE);
  console.log(
    `  ${name.padEnd(12)} E=${(exp / ONE).toFixed(3).padStart(8)}  ticks=${String(tk).padStart(5)}` +
    `  C=${(cg / ONE).toFixed(3)}  x=${metres.padStart(8)}  old=${String(old).padStart(5)}` +
    `  core=${String(core).padStart(5)}  ${old === core ? 'SAME' : 'DIFFER by ' + (core - old)}` +
    `  [delivered ${s[O_SCORE + S_DELIVERED]}]`);
  return old === core;
};

const DIR = new URL('../../../test-vectors/', import.meta.url).pathname;
const index = JSON.parse(readFileSync(DIR + 'index.json', 'utf8'));

console.log('the golden vectors, both scores from the same state:');
let same = 0, total = 0;
for (const entry of index.vectors) {
  const v = JSON.parse(readFileSync(DIR + entry.name + '.json', 'utf8'));
  const st = init(v.seed);
  for (let t = 0; t < v.ticks; t++) {
    const [th, sr, br, hb, pr] = v.inputs[t];
    step(st, th, sr, br, hb, pr);
  }
  total++;
  if (row(entry.name, st, (st.i32[O_TRUCK + T_X] / ONE).toFixed(1))) same++;
}

// The letter asks for a run past +81 m as well: the vectors above stop short of
// the far side, and the exposure clamp only bites once enough ground is made
// good. Full throttle, straight, until the truck is past it.
console.log('');
console.log('a run driven past +81 m:');
const st = init(7);
let ticks = 0;
while (st.i32[O_TRUCK + T_X] / ONE < 81 && ticks < 20000) { step(st, ONE, 0, 0, 0, 0); ticks++; }
total++;
if (row('past81m', st, (st.i32[O_TRUCK + T_X] / ONE).toFixed(1))) same++;

// And the whole grid, so the answer is not five lucky points.
console.log('');
let n = 0, bad = 0, worst = 0;
const ties = [];
for (let e = 0; e <= 220; e++)
  for (let s = 5; s <= 120; s += 5)
    for (let c = 0; c <= 10; c++) {
      const eQ = Math.round(e * ONE), tQ = s * 60, cQ = Math.round((c / 10) * ONE);
      const a = oldGame(eQ / ONE, tQ, cQ / ONE), b = scoreOf(eQ, tQ, cQ);
      n++;
      if (a !== b) {
        bad++;
        worst = Math.max(worst, Math.abs(a - b));
        if (ties.length < 4) ties.push(`E=${(eQ / ONE).toFixed(3)} ticks=${tQ} C=${(cQ / ONE).toFixed(3)}  old=${a} core=${b}`);
      }
    }
console.log(`swept ${n} combinations of exposure, elapsed and cargo`);
console.log(`  agree on ${n - bad} (${((n - bad) / n * 100).toFixed(3)}%), worst gap ${worst} point${worst === 1 ? '' : 's'}`);
for (const t of ties) console.log('    ' + t);
console.log('');
console.log(`routes: ${same} of ${total} identical`);
