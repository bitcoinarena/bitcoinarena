// kanban #1489 v1 refute #1539 (3), #1721 #1792 #1831: another door to the same effect. The safe behaviour the finding names - "the same call on
// the same input answers the same, whatever ran before it in that sandbox" - is broken without any array: the core's module
// scope lives across calls, so a core counts the calls its thread served (other rounds replayed, idle restarts) and answers
// one round differently on seats with different histories, while replaying deterministically on a fresh thread.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCore } from '../src/core-sandbox.js';

test('#1539 refute 3: a core cannot read its seat\'s call history through module state', () => {
  const src = `
let served = 0;
export const CORE = Object.freeze({
  name: 'hist', RUN_TICKS: 10, INPUT_WORDS: 1,
  runTicks(config) { served++; return served > 1 ? 9 : 10; },
  start: () => ({}), eventsOf: () => ({ count: {}, before() {} }), step() {}, stateHash: () => 'h', result: () => ({ outcome: 'X', score: 0, heat: 0 }),
});`;
  const box = loadCore({ files: new Map([['core.mjs', src]]), entry: 'core.mjs' }, { name: 'hist' });
  let a, b;
  try { a = box.call('runTicks', { config: {} }); b = box.call('runTicks', { config: {} }); } finally { box.end(); }
  console.log(`same call, same input: ${a} then ${b}`);
  assert.equal(b, a, 'the core read the seat\'s call history through its module scope');
});
