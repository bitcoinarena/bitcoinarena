// kanban #1489 v1 refute #1539 (1), #1721 #1792 #1831: LIVE_CAP is read from `live`, which only a FinalizationRegistry callback (after a GC,
// whenever one runs) lowers. An HONEST core that allocates a scratch array per call and drops it is ended once the dropped
// arrays add up past LIVE_CAP without a GC - the same call on the same input answers on a fresh thread and fails after a
// few calls: the outcome still depends on the seat's history and GC timing, and an honest core is killed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCore } from '../src/core-sandbox.js';

test('#1539 refute 1: an honest core that drops a scratch array each call is not ended by LIVE_CAP', () => {
  const src = `
export const CORE = Object.freeze({
  name: 'scratch', RUN_TICKS: 10, INPUT_WORDS: 1,
  runTicks(config) { const b = new Uint8Array(900 * 1024); b[0] = 1; return 10 + b.length * 0; },
  start: () => ({}), eventsOf: () => ({ count: {}, before() {} }), step() {}, stateHash: () => 'h', result: () => ({ outcome: 'X', score: 0, heat: 0 }),
});`;
  const box = loadCore({ files: new Map([['core.mjs', src]]), entry: 'core.mjs' }, { name: 'scratch', arrayBudget: 1024 * 1024 });
  const got = [];
  try {
    for (let i = 0; i < 12; i++) {
      try { got.push(box.call('runTicks', { config: {} })); } catch (e) { got.push('ERR: ' + e.message); }
    }
  } finally { box.end(); }
  console.log(JSON.stringify(got));
  assert.deepEqual(got, Array(12).fill(10), 'an honest core holding nothing across calls was ended (dropped arrays still counted live)');
});
