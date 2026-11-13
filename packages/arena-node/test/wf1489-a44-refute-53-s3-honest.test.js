// kanban #2475, #2508 (#1489 a44 refute of #1695): the wrapper now copies an iterable or array-like source itself. The honest
// path must give the same arrays V8 gave: arrays, Sets, generators, array-likes, holes, BigInt kinds, subclasses, from/of,
// the spec's errors - and the copy's bytes counted once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { sandboxFor } from '../src/core-sandbox.js';

const DIR = mkdtempSync(join(tmpdir(), 'wf1489-a44-53-s3h-'));
let n = 0;
function core(body) {
  const src = `const out = [];
export const CORE = Object.freeze({
  name: 'honest', RUN_TICKS: 1, INPUT_WORDS: 5,
  start: (seed) => ({ seed, t: 0 }),
  eventsOf: () => ({ count: { liquidations: 0, loads: 0, samples: 0, tapes: 0 }, before() {} }),
  step(st, w) { if (st.t === 0) { ${body} } st.t++; },
  stateHash: (st) => 'h:' + st.t,
  result: (st) => ({ outcome: out.join('|'), score: 0, heat: 0 }),
});`;
  const file = join(DIR, `core-${++n}.js`);
  writeFileSync(file, src);
  return { name: `honest ${n}`, hash: createHash('sha256').update(src).digest('hex'), url: pathToFileURL(file).href };
}
const REPLAY = { seedWord: 1, config: {}, runTicks: 1, start: 0, words: [[0, 0, 0, 0, 0]], events: {}, marks: [], pictures: [] };
const run = (body, budget = 4 * 1048576) => { try { return sandboxFor(core(body), { arrayBudget: budget }).call('replay', REPLAY).outcome; } catch (e) { return 'ERR ' + e.message; } };
// the same body run in this realm, unwrapped: what V8 itself answers
const plain = (body) => { const out = []; new Function('out', body)(out); return out.join('|'); };

const BODY = `
const s = (a) => out.push(a.constructor.name + ':' + Array.prototype.join.call(a, ','));
const e = (f) => { try { f(); out.push('no error'); } catch (x) { out.push(x.constructor.name); } };
s(new Float64Array([1, 2.5, -3]));
s(new Int8Array([1, 300, '7', null, undefined, {}]));
s(new Uint8ClampedArray([300, -5, 1.5]));
s(new Int32Array(new Set([4, 5, 6])));
s(new Uint16Array((function* () { yield 1; yield 2; })()));
s(new Float32Array({ length: 3, 0: 1, 2: 3 }));
s(new Int16Array({ length: '2.9', 0: 9, 1: 8 }));
s(new Int16Array({ length: -4 }));
s(new Uint8Array({}));
s(new Uint8Array(Object.assign(function (a, b) {}, { 0: 7 })));
s(new BigInt64Array([1n, -2n]));
s(new BigUint64Array(new Set([3n])));
s(new Float64Array([1, , 3]));
s(new Uint32Array([{ valueOf() { return 42; } }]));
class Mine extends Int32Array {}
const m = new Mine([1, 2]); out.push(String(m instanceof Mine) + ':' + Array.prototype.join.call(m, ','));
s(Int32Array.from([1, 2, 3], (v) => v * 2));
s(Float64Array.from({ length: 2, 0: 5 }));
s(Uint8Array.of(1, 2, 3));
s(new Int32Array([1, 2, 3]).map((v) => v + 1));
s(new Int32Array([3, 1, 2]).toSorted());
e(() => new BigInt64Array([1]));
e(() => new Int32Array([1n]));
e(() => new Int32Array({ [Symbol.iterator]: 5 }));
e(() => new Int32Array({ [Symbol.iterator]() { return 1; } }));
e(() => new Int32Array({ length: 2, get 0() { throw new SyntaxError('x'); } }));
e(() => new Int32Array([1, 2]).map(() => { throw new EvalError('y'); }));
`;

test('a44-53-s3 honest: every source kind copies as V8 copies it', () => {
  const want = plain(BODY);
  assert.equal(run(BODY), want);
});

test('a44-53-s3 honest: a kept array-like copy counts its bytes once - 3 x 1 MB fit 4 MB, 5 x 1 MB do not', () => {
  const body = (k) => `const keep = []; for (let i = 0; i < ${k}; i++) keep.push(new Uint8Array({ length: 1048576 })); out.push(keep.length);`;
  assert.equal(run(body(3)), '3');
  assert.match(run(body(5)), /asked for more than 4 MB of arrays/);
  const it = (k) => `const keep = []; const a = new Array(1048576).fill(1); for (let i = 0; i < ${k}; i++) keep.push(new Uint8Array(a)); out.push(keep.length);`;
  assert.equal(run(it(3), 4 * 1048576 + 64), '3');
});

test('a44-53-s3: an endless iterable stops at the budget, not at the heap', () => {
  assert.match(run('new Float64Array({ *[Symbol.iterator]() { for (;;) yield 1; } });'), /asked for more than 4 MB of arrays/);
});
