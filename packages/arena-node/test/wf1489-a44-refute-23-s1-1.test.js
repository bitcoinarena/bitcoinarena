// kanban #1489 a44 refute 23 (#1622, #2145, #2211): the fix wraps every typed array kind's constructor (Float16Array too), but a copy made
// through the species path falls back to the realm's RAW intrinsic when the exemplar's own \`constructor\` is undefined or has
// no @@species (TypedArraySpeciesCreate / SpeciesConstructor, ECMA-262). A core defines an own \`constructor\` on one array
// and its slice/map/filter copies are allocated by the unwrapped Float16Array: counted neither by the per-call budget
// (#1539) nor by the live cap (#1538). Safe behaviour: those copies are refused past the budget like new Float16Array(n).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { sandboxFor } from '../src/core-sandbox.js';

const DIR = mkdtempSync(join(tmpdir(), 'wf1489-a44-r23-'));
let n = 0;
function core(step, top = '') {
  const src = `const kept = []; ${top}
export const CORE = Object.freeze({
  name: 'hostile', RUN_TICKS: 10, INPUT_WORDS: 5,
  start: (seed) => ({ seed, t: 0 }),
  eventsOf: () => ({ count: { liquidations: 0, loads: 0, samples: 0, tapes: 0 }, before() {} }),
  step(st, w) { ${step}; st.t++; },
  stateHash: (st) => 'h:' + st.seed + ':' + st.t,
  result: (st) => ({ outcome: 'DELIVERED', score: st.t, heat: 0 }),
});`;
  const file = join(DIR, `core-${++n}.js`);
  writeFileSync(file, src);
  return { name: `hostile ${n}`, hash: createHash('sha256').update(src).digest('hex'), url: pathToFileURL(file).href };
}
const MB = 1048576;
const REPLAY = { seedWord: 1, config: {}, runTicks: 10, start: 0, words: [[0, 0, 0, 0, 0]], events: {}, marks: [], pictures: [] };
const attempt = (c, o = {}) => { try { const r = sandboxFor(c, { arrayBudget: 4 * MB, ...o }).call('replay', REPLAY); return 'answered ' + JSON.stringify(r).slice(0, 80); } catch (e) { return e.message; } };
const OVER = /asked for more than 4 MB of arrays/;
test('Float16Array slice with an own constructor undefined is counted', () => {
  assert.match(attempt(core('const a = new Float16Array(1048576); Object.defineProperty(a, "constructor", { value: undefined }); for (let i = 0; i < 8; i++) kept.push(a.slice())')), OVER);
});
test('Float16Array map with an own constructor without @@species is counted', () => {
  assert.match(attempt(core('const a = new Float16Array(1048576); Object.defineProperty(a, "constructor", { value: {} }); for (let i = 0; i < 8; i++) kept.push(a.map((x) => x))')), OVER);
});
test('Float16Array filter with an own constructor undefined is counted', () => {
  assert.match(attempt(core('const a = new Float16Array(1048576); Object.defineProperty(a, "constructor", { value: undefined }); for (let i = 0; i < 8; i++) kept.push(a.filter(() => true))')), OVER);
});
