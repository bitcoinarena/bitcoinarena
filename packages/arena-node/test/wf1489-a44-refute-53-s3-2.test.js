// kanban #1489 a44 refute #1695 / #2238 (skeptic 3): THE COPYING WRAPPER COUNTS AFTER THE COPY - AND map RUNS CORE CODE
// AFTER THE ALLOCATION. core-host.js's #2238 wrapper takes the source's bytes (a check, not a count), lets the intrinsic
// allocate through the raw species default, and counts the result only when apply returns. %TypedArray%.prototype.map calls
// the core's callback for every element after the result is allocated; a callback that throws on the last element skips
// the count: 2 MB allocated each time, `used` never moves, the core catches and repeats - 8 x 2 MB past a 4 MB budget.
// Safe behaviour: every allocation in a call is counted against the per-call budget, whatever the core's callback does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { sandboxFor } from '../src/core-sandbox.js';

const DIR = mkdtempSync(join(tmpdir(), 'wf1489-a44-53-s3b-'));
let n = 0;
function core(top, step) {
  const src = `${top}
const kept = [];
export const CORE = Object.freeze({
  name: 'hostile', RUN_TICKS: 10, INPUT_WORDS: 5,
  start: (seed) => ({ seed, t: 0 }),
  eventsOf: () => ({ count: { liquidations: 0, loads: 0, samples: 0, tapes: 0 }, before() {} }),
  step(st, w) { ${step}; st.t++; },
  stateHash: (st) => 'h:' + st.seed + ':' + st.t,
  result: (st) => ({ outcome: 'DELIVERED', score: kept.length, heat: 0 }),
});`;
  const file = join(DIR, `core-${++n}.js`);
  writeFileSync(file, src);
  return { name: `hostile ${n}`, hash: createHash('sha256').update(src).digest('hex'), url: pathToFileURL(file).href };
}
const MB = 1048576;
const REPLAY = { seedWord: 1, config: {}, runTicks: 10, start: 0, words: [[0, 0, 0, 0, 0]], events: {}, marks: [], pictures: [] };
const attempt = (c, budget = 4 * MB) => { try { const r = sandboxFor(c, { arrayBudget: budget }).call('replay', REPLAY); return `answered (${r.score} uncounted allocations)`; } catch (e) { return e.message; } };
const TOP = `const src = new Uint8Array(2 * 1048576); Object.defineProperty(src, 'constructor', { value: undefined });`;
const LAST = 2 * 1048576 - 1;

test('control: 8 kept maps of 2 MB past a 4 MB budget are refused', () => {
  assert.match(attempt(core(TOP, 'if (st.t === 0) for (let i = 0; i < 8; i++) kept.push(src.map((v) => v))')), /asked for more than 4 MB of arrays/);
});

test('a44-53-s3: 8 maps of 2 MB whose callback throws at the last element are counted (16 MB past 4 MB)', () => {
  const got = attempt(core(TOP, `if (st.t === 0) for (let i = 0; i < 8; i++) { let reached = false; try { src.map((v, j) => { if (j === ${LAST}) { reached = true; throw 0; } return v; }); } catch {} if (reached) kept.push(1); }`));
  console.log(`map throw: ${got}`);
  assert.match(got, /asked for more than 4 MB of arrays/);
});
