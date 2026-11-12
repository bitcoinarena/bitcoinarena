// kanban #1489 round 5 (hosting): THE ARRAY BUDGET TRUSTS THE CORE'S OWN INTRINSICS.
// core-host.js's LOCKDOWN wraps every typed-array constructor and counts what it allocates, but it measures the allocation
// with intrinsics the core can replace before it allocates anything: `o.byteLength` is read through
// %TypedArray%.prototype.byteLength (a configurable accessor), `x.length` is an ordinary property, and the real construct goes
// through `Reflect.construct` looked up on the shared Reflect object at every call - which hands an overriding function the
// raw, unwrapped constructor. A core that redefines byteLength (no word the plugin scan refuses) or Reflect.construct allocates
// and keeps arrays that neither the per-call budget nor the live cap ever sees: each call may grow the seat up to the RSS
// backstop, and the plugin trial (liveCap = budget, kanban #1538) passes an adapter that keeps hundreds of MB.
// Not the Float16Array kind (r4): these use the wrapped Uint8Array/Float64Array/ArrayBuffer themselves.
// Safe behaviour: arrays past the budget are refused however the core has changed its own realm.
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

const DIR = mkdtempSync(join(tmpdir(), 'wf1489-r5-hosting-3-'));
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

// the byteLength accessor answers 0, and the source's own `length` says 0: the wrapper counts nothing, V8 copies the whole source
const BYTELENGTH = `const TA = Object.getPrototypeOf(Uint8Array.prototype);
Object.defineProperty(TA, 'byteLength', { get() { return 0; } });
const src = new Uint8Array(2 * 1048576);
Object.defineProperty(src, 'length', { value: 0 });`;
// Reflect.construct, looked up at every call by the wrapper, hands the raw constructor to whoever replaced it
const REFLECT = `const real = Reflect.construct; let Raw = null;
Reflect.construct = function (t, a, nt) { if (!Raw && t.name === 'ArrayBuffer') Raw = t; return real(t, a, nt); };
new ArrayBuffer(1);
Reflect.construct = real;`;

test('control: 16 MB of Float64Array past a 4 MB budget is refused', () => {
  assert.match(attempt(core('', 'kept.push(new Float64Array(2 * 1048576))')), /asked for more than 4 MB of arrays/);
});

test('#1489-r5-hosting-1a: a core that redefines byteLength is still held to the budget (16 MB copied past 4 MB)', () => {
  const got = attempt(core(BYTELENGTH, 'for (let i = 0; i < 8; i++) kept.push(new Uint8Array(src))'));
  console.log(`byteLength override: ${got}`);
  assert.match(got, /asked for more than 4 MB of arrays/);
});

test('#1489-r5-hosting-1b: a core that captures the raw constructor through Reflect.construct is still held to the budget', () => {
  // (kanban #1695) closed either way: the wrapper never calls the core's Reflect.construct, so the raw constructor is never handed out
  const got = attempt(core(REFLECT, "if (!Raw) throw new Error('no raw constructor reached the core'); kept.push(new Raw(16 * 1048576))"));
  console.log(`Reflect.construct capture: ${got}`);
  assert.match(got, /asked for more than 4 MB of arrays|no raw constructor reached the core/);
});

test('#1489-r5-hosting-1c: a decide adapter that keeps 8 MB per call by the byteLength trick does not pass the plugin trial', () => {
  const adapter = `const TA = Object.getPrototypeOf(Uint8Array.prototype);
Object.defineProperty(TA, 'byteLength', { get() { return 0; } });
const src = new Uint8Array(8 * 1048576);
Object.defineProperty(src, 'length', { value: 0 });
const kept = [];
export const DECIDE = { name: 'hog', decide(moves) { kept.push(new Uint8Array(src)); const out = {}; for (const m of moves) out[m.key] = 'DRAW'; return out; } };`;
  assert.deepEqual(scanSource(adapter), [], 'the adapter passes the plugin scan');
  const t = trialRun(adapter, { resultType: RESULT_TYPE.HEAD_TO_HEAD, moveCount: 3, players: 2 });
  console.log(`trial: ok=${t.ok} cases=${t.cases} why=${t.why || ''} (kept ~${(t.cases || 0) * 2 * 8} MB of arrays, live cap 64 MB)`);
  assert.equal(t.ok, false, `an adapter that kept ${(t.cases || 0) * 2 * 8} MB of arrays passed the trial`);
});
