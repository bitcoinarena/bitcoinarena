// kanban #1489 v1 refute #1539 (4), #1721 #1792 #1831: the original attack with the production budget, repeated: 40 MB dropped per call, 10 calls.
// Each call is under the 64 MB per-call budget; the core keeps nothing. LIVE_CAP (256 MB) must not end it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCore } from '../src/core-sandbox.js';

test('#1539 refute 4: 40 MB dropped per call, ten calls, all answer the same', () => {
  const src = `
export const CORE = Object.freeze({
  name: 'probe', RUN_TICKS: 10, INPUT_WORDS: 1,
  runTicks(config) { try { const b = new Uint8Array(40 * 1048576); b[0] = 1; return 10; } catch { return 9; } },
  start: () => ({}), eventsOf: () => ({ count: {}, before() {} }), step() {}, stateHash: () => 'h', result: () => ({ outcome: 'X', score: 0, heat: 0 }),
});`;
  const box = loadCore({ files: new Map([['core.mjs', src]]), entry: 'core.mjs' }, { name: 'probe' });
  const got = [];
  try { for (let i = 0; i < 10; i++) { try { got.push(box.call('runTicks', { config: {} })); } catch (e) { got.push('ERR: ' + e.message); } } } finally { box.end(); }
  console.log(JSON.stringify(got));
  assert.deepEqual(got, Array(10).fill(10));
});
