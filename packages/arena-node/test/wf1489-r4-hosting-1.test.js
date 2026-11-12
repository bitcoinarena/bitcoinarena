// kanban #1489 round 4 (hosting): the core sandbox's array budget and its live cap (kanban #1539) count every typed array
// kind a core can construct. Float16Array is a global of the core's realm on node 24, and it is not among the wrapped kinds:
// a hostile core allocates its arrays as Float16Array outside the budget, and keeps them alive across calls outside the
// live cap - each call may grow the seat by just under the RSS backstop, and nothing ends the core between calls.
// Safe behaviour: a Float16Array past the budget is refused like a Float64Array past it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { sandboxFor } from '../src/core-sandbox.js';

const DIR = mkdtempSync(join(tmpdir(), 'wf1489-r4-hosting-1-'));
let n = 0;
function core(step) {
  const src = `const kept = [];
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
const attempt = (c) => {
  try { sandboxFor(c, { arrayBudget: 4 * MB }).call('replay', REPLAY); return 'answered'; } catch (e) { return e.message; }
};

test('control: a Float64Array of 16 MB past a 4 MB budget is refused', () => {
  assert.match(attempt(core('kept.push(new Float64Array(2 * 1048576))')), /asked for more than 4 MB of arrays/);
});

test('a Float16Array of 16 MB past a 4 MB budget is refused the same way', () => {
  assert.equal(typeof Float16Array, 'function', 'this node has Float16Array');
  assert.match(attempt(core('kept.push(new Float16Array(8 * 1048576))')), /asked for more than 4 MB of arrays/);
});
