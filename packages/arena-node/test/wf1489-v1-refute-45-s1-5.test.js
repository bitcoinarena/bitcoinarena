// kanban #1489 v1 refute #1539 (5), #1721 #1792 #1831: what the fix keeps. The long-lived context (the warm ghost's, the plugin
// trial's) still ends a core that KEEPS arrays past its cap - counted exactly after a GC - and never one that drops them; a
// call past its budget fails alone, the calls after it answer as on a fresh thread; a subclass cannot hide its arrays.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCore } from '../src/core-sandbox.js';
import { trialRun } from '../src/plugin-trial.js';
import { RESULT_TYPE } from '../../arena-protocol/src/manifest.js';

const coreOf = (top, step, extra = '') => ({ files: new Map([['core.mjs', `${top}
export const CORE = Object.freeze({
  name: 'k', RUN_TICKS: 10, INPUT_WORDS: 1, ${extra}
  start: () => ({ t: 0 }), eventsOf: () => ({ count: {}, before() {} }), step(st, w) { ${step}; st.t++; }, stateHash: (st) => 'h' + st.t,
  result: (st) => ({ outcome: 'X', score: st.t, heat: 0 }), picture: (st) => ({ t: st.t }),
});`]]), entry: 'core.mjs' });
const REPLAY = (w) => ({ seedWord: 1, config: {}, runTicks: 10, start: 0, words: [[w]], events: {}, marks: [], pictures: [] });

test('#1792: a decide adapter that keeps 8 MB per call is refused by the trial for what it keeps', () => {
  const src = `const kept = [];
export const DECIDE = Object.freeze({ name: 'hog', decide(moves) { kept.push(new Uint8Array(8 * 1048576)); const out = {}; for (const m of moves) out[m.key] = 'DRAW'; return out; } });`;
  const r = trialRun(src, { resultType: RESULT_TYPE.HEAD_TO_HEAD, moveCount: 4, players: 2 });
  console.log(JSON.stringify(r));
  assert.equal(r.ok, false);
  assert.match(r.why, /kept more than 64 MB of arrays alive/);
});

test('#1721: the warm ghost that drops 900 KB per step is not ended; one that keeps them is, and replays still answer', () => {
  const box = loadCore(coreOf('', 'const b = new Uint8Array(900 * 1024); b[0] = w[0]'), { name: 'drop', arrayBudget: 1024 * 1024 });
  try {
    const id = box.call('open', { seedWord: 1, config: {}, runTicks: 10 });
    for (let i = 0; i < 12; i++) assert.deepEqual(box.call('stepTo', { id, events: {}, from: i, words: [[1]] }), { t: i + 1 });
  } finally { box.end(); }
  const keep = loadCore(coreOf('const kept = [];', 'kept.push(new Uint8Array(900 * 1024))'), { name: 'keep', arrayBudget: 1024 * 1024 });
  try {
    const id = keep.call('open', { seedWord: 1, config: {}, runTicks: 10 });
    let why = null;
    for (let i = 0; i < 12 && !why; i++) { try { keep.call('stepTo', { id, events: {}, from: i, words: [[1]] }); } catch (e) { why = e.message; } }
    assert.match(String(why), /kept more than 4 MB of arrays alive/);
    // the calls the node signs run in contexts of their own: the warm context's end does not touch them
    assert.equal(keep.call('replay', REPLAY(1)).stateHash, 'h1');
  } finally { keep.end(); }
});

test('#1831: a call past its array budget fails alone - the next call answers as on a fresh thread', () => {
  const box = loadCore(coreOf('', 'if (w[0] === 9) { const k = []; for (;;) k.push(new Uint8Array(1 << 20)); }'), { name: 'over', arrayBudget: 8 * 1048576 });
  try {
    assert.equal(box.call('replay', REPLAY(1)).stateHash, 'h1');
    assert.throws(() => box.call('replay', REPLAY(9)), /asked for more than 8 MB of arrays/);
    assert.equal(box.call('replay', REPLAY(1)).stateHash, 'h1');
  } finally { box.end(); }
});

test('#1721: a subclass whose byteLength answers 0 does not hide its arrays from the budget', () => {
  const box = loadCore(coreOf('class Z extends Uint8Array { get byteLength() { return 0; } }', 'const k = []; for (let i = 0; i < 64; i++) k.push(new Z(1 << 20))'),
    { name: 'hide', arrayBudget: 8 * 1048576 });
  try { assert.throws(() => box.call('replay', REPLAY(1)), /asked for more than 8 MB of arrays/); } finally { box.end(); }
});

test('#1831: a replay (never answered from a memo) cannot read the seat\'s call history through module state either', () => {
  const box = loadCore(coreOf('let served = 0;', 'st.t += served++'), { name: 'hist' });
  try {
    const a = box.call('replay', REPLAY(1)).stateHash, b = box.call('replay', REPLAY(1)).stateHash;
    const id = box.call('open', { seedWord: 1, config: {}, runTicks: 10 });
    box.call('stepTo', { id, events: {}, from: 0, words: [[1]] });
    const c = box.call('replay', REPLAY(1)).stateHash;
    assert.deepEqual([a, b, c], ['h1', 'h1', 'h1']);
  } finally { box.end(); }
});
