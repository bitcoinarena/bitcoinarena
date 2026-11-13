// kanban #1489 v1 refute #1539 skeptic 3 (1): the #2008 fix made a signed call whose own thread dies "fail alone", but the
// same "a dead thread ends the whole core" logic is still there on the KEPT thread (the warm ghost). A ghost stepped over a
// player's input that kills the thread's heap (deterministic: set by the input) sets loadCore's `ended`, and from then on
// every call the node signs on - replay, runTicks, runTicksFits, even memoized meta - throws on that seat, while a seat
// that never drew that ghost answers them. The seat's history (which ghosts it drew) decides its answer again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCore } from '../src/core-sandbox.js';

const coreOf = (step) => ({ files: new Map([['core.mjs', `
export const CORE = Object.freeze({
  name: 'k', RUN_TICKS: 10, INPUT_WORDS: 1, runTicks: () => 10, runTicksFits: (t) => t >= 1 && t <= 10,
  start: () => ({ t: 0 }), eventsOf: () => ({ count: {}, before() {} }), step(st, w) { ${step}; st.t++; }, stateHash: (st) => 'h' + st.t,
  result: (st) => ({ outcome: 'X', score: st.t, heat: 0 }), picture: (st) => ({ t: st.t }),
});`]]), entry: 'core.mjs' });
const REPLAY = (w) => ({ seedWord: 1, config: {}, runTicks: 10, start: 0, words: [[w]], events: {}, marks: [], pictures: [] });
const answers = (s) => ['replay', 'runTicks', 'runTicksFits', 'meta'].map((op) => {
  try {
    const r = op === 'replay' ? s.call(op, REPLAY(1)).stateHash : op === 'runTicks' ? s.call(op, { config: {} })
      : op === 'runTicksFits' ? s.call(op, { ticks: 5 }) : s.call(op, {}).name;
    return JSON.stringify(r);
  } catch (e) { return `threw: ${e.message.slice(0, 60)}`; }
});

test('a warm ghost whose kept thread dies of its heap does not end the signed calls on that seat', () => {
  const core = coreOf('if (w[0] === 9) { const k = []; for (;;) k.push({ a: [1, 2, 3, 4, 5, 6, 7, 8], s: "x" + k.length }); }');
  const opts = { heap: { maxOldGenerationSizeMb: 24, maxYoungGenerationSizeMb: 4 }, callMs: 30000, stepMs: 30000 };
  const fresh = loadCore(core, { name: 'fresh', ...opts });
  const seen = loadCore(core, { name: 'seen', ...opts });
  try {
    const id = seen.call('open', { seedWord: 1, config: {}, runTicks: 10 });
    assert.throws(() => seen.call('stepTo', { id, events: {}, from: 0, words: [[9]] }), /died|did not stop|grew/);
    assert.deepEqual(answers(seen), answers(fresh));
  } finally { fresh.end(); seen.end(); }
});
