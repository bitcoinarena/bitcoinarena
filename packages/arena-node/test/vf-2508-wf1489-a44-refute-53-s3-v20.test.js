// kanban #1489 a44 refute #1695 (skeptic 2): THE SPECIES DEFAULT HANDS OUT THE RAW CONSTRUCTOR.
// core-host.js wraps each typed-array constructor and locks it as K.prototype.constructor, and says that so `slice`, `map`,
// `filter` (the species path) are counted. But SpeciesConstructor(O, default) returns the DEFAULT - the realm's intrinsic,
// unwrapped %Uint8Array% / %ArrayBuffer% - when O.constructor is undefined. A core (or a plugin adapter) that shadows the
// instance's own `constructor` with undefined copies any counted array through the raw constructor: nothing counted by the
// per-call budget, nothing by the live cap. Safe behaviour: every copy is counted, however the core shapes the instance.
// kanban #2508 (#2536): the card's v20 copy as 1.9 reads it - the same adaptation as sup-2238-species-budget (that file).
// Adapted to 1.9 by #2536 (kanban #2238): the species/slice budget tests are unchanged (green); the live-cap test assumed one kept thread
// across calls, which 1.9 no longer has for a replay - it is replaced by the check that nothing is kept from one call into the next.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { sandboxFor } from '../src/core-sandbox.js';
import { trialRun } from '../src/plugin-trial.js';
import { RESULT_TYPE } from '../../arena-protocol/src/manifest.js';
import { scanSource } from '../src/plugin-check.js';

const DIR = mkdtempSync(join(tmpdir(), 'wf1489-a44-53-s2-'));
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
const attempt = (c) => { try { const r = sandboxFor(c, { arrayBudget: 4 * MB }).call('replay', REPLAY); return `answered (kept ${r.score} arrays)`; } catch (e) { return e.message; } };
// a 2 MB array, counted once at load (the top level's own budget), its own constructor shadowed by undefined
const TOP = `const src = new Uint8Array(2 * 1048576); Object.defineProperty(src, 'constructor', { value: undefined });
const buf = new ArrayBuffer(2 * 1048576); Object.defineProperty(buf, 'constructor', { value: undefined });`;

test('control: 8 copies of 2 MB through new Uint8Array past a 4 MB budget are refused', () => {
  assert.match(attempt(core(TOP, 'for (let i = 0; i < 8; i++) kept.push(new Uint8Array(src))')), /asked for more than 4 MB of arrays/);
});

for (const [what, step] of [
  ['slice', 'for (let i = 0; i < 8; i++) kept.push(src.slice())'],
  ['map', 'for (let i = 0; i < 8; i++) kept.push(src.map((v) => v))'],
  ['filter', 'for (let i = 0; i < 8; i++) kept.push(src.filter(() => true))'],
  ['ArrayBuffer slice', 'for (let i = 0; i < 8; i++) kept.push(buf.slice(0))'],
  ['species undefined', "const s2 = new Uint8Array(2 * 1048576); Object.defineProperty(s2, 'constructor', { value: { [Symbol.species]: undefined } }); for (let i = 0; i < 8; i++) kept.push(s2.slice())"],
]) {
  test(`a44-53-s2: TypedArray ${what} with the instance's constructor shadowed is held to the budget (16 MB past 4 MB)`, () => {
    const got = attempt(core(TOP, step));
    console.log(`${what}: ${got}`);
    assert.match(got, /asked for more than 4 MB of arrays/);
  });
}

// 1.9 runs every replay on a core thread started for that one call (#1721, #1792, #1831), so what a core keeps cannot outlive its call: the
// live cap across calls has nothing to hold. The same core, 8 calls: each call starts from nothing kept (its score, kept.length, is 1).
test('#2238 (1.9): the slice trick keeps nothing across calls - each replay runs on a thread of its own', () => {
  const c = core(TOP, 'kept.push(src.slice())');
  const sb = sandboxFor(c, { arrayBudget: 4 * MB, liveCap: 4 * MB });
  const scores = [];
  for (let i = 0; i < 8; i++) scores.push(sb.call('replay', REPLAY).score);
  console.log(`kept per call: ${JSON.stringify(scores)}`);
  assert.deepEqual(scores, Array(8).fill(1), 'a core kept arrays from one call into the next');
});

test('a44-53-s2: a plugin adapter (a stranger, not a seat) keeping 8 MB per call through slice does not pass the trial', () => {
  const adapter = `const src = new Uint8Array(8 * 1048576);
Object.defineProperty(src, 'constructor', { value: undefined });
const kept = [];
export const DECIDE = { name: 'hog', decide(moves) { kept.push(src.slice()); const out = {}; for (const m of moves) out[m.key] = 'DRAW'; return out; } };`;
  assert.deepEqual(scanSource(adapter), [], 'the adapter passes the plugin scan');
  const t = trialRun(adapter, { resultType: RESULT_TYPE.HEAD_TO_HEAD, moveCount: 3, players: 2 });
  console.log(`trial: ok=${t.ok} cases=${t.cases} why=${t.why || ''}`);
  assert.equal(t.ok, false, `an adapter that kept ~${(t.cases || 0) * 8} MB of arrays passed the trial`);
});
