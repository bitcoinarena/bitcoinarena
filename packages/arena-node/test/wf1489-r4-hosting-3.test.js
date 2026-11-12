// kanban #1489 round 4 (hosting): the same call on the same input answers the same whatever the thread ran before (kanban
// #1539's rule, closed there for the array budget). The stack is a second budget a core can read: it recurses until V8's
// RangeError ("Maximum call stack size exceeded"), catches it and counts the frames. A frame's size depends on the tier the
// function runs in (interpreter, baseline, optimized), so the depth moves as the thread warms up - a seat that replayed other
// runs first answers another depth than a fresh one, and committee seats with different histories (and machines) split.
// Safe behaviour: the stack's depth is not a value the core can branch on - every call answers the same.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { sandboxFor } from '../src/core-sandbox.js';

const DIR = mkdtempSync(join(tmpdir(), 'wf1489-r4-hosting-3-'));
const src = `const depth = () => { let d = 0; const f = (x) => { d++; return f(x + 1) + 1; }; try { f(0); } catch { /* the stack's end */ } return d; };
export const CORE = Object.freeze({
  name: 'stack', RUN_TICKS: 10, INPUT_WORDS: 5,
  start: (seed) => ({ seed, t: 0, d: 0 }),
  eventsOf: () => ({ count: { liquidations: 0, loads: 0, samples: 0, tapes: 0 }, before() {} }),
  step(st, w) { st.d = depth(); st.t++; },
  stateHash: (st) => 'h:' + st.seed + ':' + st.t + ':' + st.d,
  result: (st) => ({ outcome: st.d % 2 ? 'DELIVERED' : 'FAILED', score: st.d, heat: 0 }),
});`;
const file = join(DIR, 'core.js');
writeFileSync(file, src);
const core = { name: 'stack', hash: createHash('sha256').update(src).digest('hex'), url: pathToFileURL(file).href };
const REPLAY = { seedWord: 1, config: {}, runTicks: 10, start: 0, words: [[0, 0, 0, 0, 0]], events: {}, marks: [], pictures: [] };

test('the same replay on the same input, called 400 times on one thread, answers one score', () => {
  const s = sandboxFor(core);
  const scores = [];
  for (let i = 0; i < 400; i++) scores.push(s.call('replay', REPLAY).score);
  assert.deepEqual([...new Set(scores)], [scores[0]], `the core read its thread's history through the stack depth: ${[...new Set(scores)].join(', ')}`);
});
