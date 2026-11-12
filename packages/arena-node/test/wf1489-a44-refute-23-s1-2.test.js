// kanban #1489 a44 refute 23 (#1622, #2145, #2211): the same species fallback on ArrayBuffer.prototype.slice - an ArrayBuffer whose own
// \`constructor\` is undefined is copied by the realm's raw %ArrayBuffer%, outside the budget and the live cap.
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
test('ArrayBuffer slice with an own constructor undefined is counted', () => {
  assert.match(attempt(core('const a = new ArrayBuffer(2 * 1048576); Object.defineProperty(a, "constructor", { value: undefined }); for (let i = 0; i < 8; i++) kept.push(a.slice(0))')), OVER);
});
