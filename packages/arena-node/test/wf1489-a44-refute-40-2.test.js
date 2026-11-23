// kanban #1489 a44 refute of #1624 (variant: warm-up INSIDE one fresh replay). The fresh thread gives every replay the same
// history at its start, but the core can make its own: call the recursion many times shallowly so V8 tiers it up (TurboFan
// compiles on a background thread, so when the optimized code lands depends on timing), then measure the depth. Safe
// behaviour: 40 replays of one input, each on its fresh thread, answer one score.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { sandboxFor } from '../src/core-sandbox.js';

const DIR = mkdtempSync(join(tmpdir(), 'wf1489-a44-refute-40-2-'));
const src = `let d = 0; const f = (x, n) => { d++; return n > 0 ? f(x + 1, n - 1) + 1 : 0; };
const depth = () => { d = 0; try { f(0, 1e9); } catch { } return d; };
export const CORE = Object.freeze({
  name: 'stack2', RUN_TICKS: 10, INPUT_WORDS: 5,
  start: (seed) => ({ seed, t: 0, d: '' }),
  eventsOf: () => ({ count: { liquidations: 0, loads: 0, samples: 0, tapes: 0 }, before() {} }),
  step(st, w) { for (let i = 0; i < 300; i++) f(0, 50); st.d += depth() + ','; st.t++; },
  stateHash: (st) => 'h:' + st.seed + ':' + st.t + ':' + st.d,
  result: (st) => ({ outcome: 'DELIVERED', score: 0, heat: 0, d: st.d }),
});`;
const file = join(DIR, 'core.js');
writeFileSync(file, src);
const core = { name: 'stack2', hash: createHash('sha256').update(src).digest('hex'), url: pathToFileURL(file).href };
const REPLAY = { seedWord: 1, config: {}, runTicks: 10, start: 0, words: [[0, 0, 0, 0, 0]], events: {}, marks: [], pictures: [] };

test('40 fresh-thread replays of one input that warm up their own recursion answer one result', () => {
  const s = sandboxFor(core);
  const seen = new Map();
  for (let i = 0; i < 40; i++) { const r = s.call('replay', REPLAY); const k = JSON.stringify(r); seen.set(k, (seen.get(k) || 0) + 1); }
  assert.equal(seen.size, 1, `fresh threads answered ${seen.size} results: ${[...seen].map(([k, n]) => n + 'x ' + k.slice(0, 200)).join(' | ')}`);
});
