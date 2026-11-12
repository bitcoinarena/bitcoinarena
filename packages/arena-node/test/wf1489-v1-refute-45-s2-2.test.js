// kanban #1489 v1 refute #1539 skeptic 2 (2): a replay whose fresh thread dies of its heap on one input (deterministic: every
// seat that runs it dies) ends the core on that seat for every later round - the analogue of the array budget the fix made
// "fail alone". Seats that sat on different committees then split on an unrelated round.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCore } from '../src/core-sandbox.js';

const coreOf = (step) => ({ files: new Map([['core.mjs', `
export const CORE = Object.freeze({
  name: 'k', RUN_TICKS: 10, INPUT_WORDS: 1,
  start: () => ({ t: 0 }), eventsOf: () => ({ count: {}, before() {} }), step(st, w) { ${step}; st.t++; }, stateHash: (st) => 'h' + st.t,
  result: (st) => ({ outcome: 'X', score: st.t, heat: 0 }), picture: (st) => ({ t: st.t }),
});`]]), entry: 'core.mjs' });
const REPLAY = (w) => ({ seedWord: 1, config: {}, runTicks: 10, start: 0, words: [[w]], events: {}, marks: [], pictures: [] });

test('a replay whose thread dies of its heap fails alone: the next round answers as on a seat that never ran it', () => {
  const core = coreOf('if (w[0] === 9) { const k = []; for (;;) k.push({ a: [1, 2, 3, 4, 5, 6, 7, 8], s: "x" + k.length }); }');
  const opts = { heap: { maxOldGenerationSizeMb: 24, maxYoungGenerationSizeMb: 4 }, callMs: 30000 };
  const fresh = loadCore(core, { name: 'fresh', ...opts });
  const seen = loadCore(core, { name: 'seen', ...opts });
  try {
    assert.throws(() => seen.call('replay', REPLAY(9)), /died|did not stop|grew/);
    const a = fresh.call('replay', REPLAY(1)).stateHash;
    let b; try { b = seen.call('replay', REPLAY(1)).stateHash; } catch (e) { b = `threw: ${e.message}`; }
    assert.deepEqual([a, b], ['h1', 'h1']);
  } finally { fresh.end(); seen.end(); }
});
