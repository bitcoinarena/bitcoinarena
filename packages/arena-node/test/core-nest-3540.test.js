// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3540 (the owner 2026-11-25, option 2): the built-ins that recurse on a core's data are capped at a fixed depth (core-nest.js),
// on the same count as the core's own calls (DEPTH_MAX), so every seat refuses the same cores whatever its architecture. Each capped
// built-in answers at depth N - 1 and refuses at N + 1 with the one fixed message, the same whether or not V8's stack would have
// overflowed; what it answers under the cap is what V8 answers; and a core cannot reach the uncapped original.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCore } from '../src/core-sandbox.js';
import { DEPTH_MAX, NEST_SAID } from '../src/core-depth.js';

const N = DEPTH_MAX;
const load = (src) => loadCore({ files: new Map([['core.mjs', src]]), entry: 'core.mjs' }, { name: 'nest-3540' });
/** The core's top level sets SAID (a string); answers it, or throws why the core was refused. */
const said = (body) => {
  const box = load(`${body}\nexport const DECIDE = { name: SAID, decide(moves) { const out = {}; for (const m of moves) out[m.key] = 'WIN'; return out; } };`);
  try { return box.meta.name; } finally { box.end(); }
};
const refusal = (body) => { try { said(`${body}\nconst SAID = 'loaded';`); return 'loaded'; } catch (e) { return e.message; } };

// each capped built-in, as a function of a depth k: the data it recurses into is k levels deep, and `big` levels for "would overflow"
const NEST = `const nest = (k, leaf) => { let a = leaf; for (let i = 0; i < k; i++) a = [a]; return a; };
const nestObj = (k) => { let a = 1; for (let i = 0; i < k; i++) a = { a }; return a; };
const errs = (k) => { let o = 'x'; for (let i = 0; i < k; i++) o = { name: o, message: '', toString: Error.prototype.toString }; return o; };
const res = (k) => { let o = 'x'; for (let i = 0; i < k; i++) o = { source: o, flags: '', toString: RegExp.prototype.toString }; return o; };`;
const CAPPED = {
  'String() (Array.prototype.join)': (k) => `String(nest(${k}, 1)).length`,
  'Array.prototype.join': (k) => `nest(${k}, 1).join('-').length`,
  'Array.prototype.toLocaleString': (k) => `nest(${k}, 1).toLocaleString().length`,
  'Error.prototype.toString': (k) => `String(errs(${k})).length`,
  'RegExp.prototype.toString': (k) => `String(res(${k})).length`,
  'JSON.stringify': (k) => `JSON.stringify(nest(${k}, 1)).length`,
  'JSON.stringify (objects)': (k) => `JSON.stringify(nestObj(${k})).length`,
  'JSON.stringify (replacer function)': (k) => `JSON.stringify(nest(${k}, 1), (key, v) => v).length`,
  'JSON.stringify (property list)': (k) => `JSON.stringify(nestObj(${k}), ['a']).length`,
  'JSON.parse (reviver)': (k) => `JSON.stringify(JSON.parse('['.repeat(${k}) + '1' + ']'.repeat(${k}), (key, v) => v)).length`,
  'JSON.parse (reviver adds the depth)': (k) => `JSON.stringify(JSON.parse('[0,1]', function (key, v) { if (key === '0' && this.length === 2) this[1] = nest(${k} - 1, 1); return v; })).length`,
  'Array.prototype.flat': (k) => `nest(${k}, 1).flat(Infinity).length`,
};
// a probe per built-in: k levels where V8's own stack would run out (x86_64, node 24, 32 MB: join ~105k, stringify > 300k in
// time, Error.toString ~27k, parse's reviver ~77k, flat ~301k) - or a structure with no end
const BIG = 400000;

test('each capped built-in answers at depth N - 1 and refuses at N + 1 with the fixed message', () => {
  // at the module's top level, where no function of the core's is on the count: the data's levels are the whole count
  const at = (e) => `try { t = 'ok:' + (${e}); } catch (e) { t = e.constructor.name + ':' + e.message; } out.push(t);`;
  const body = `${NEST}
const out = []; let t;
${Object.values(CAPPED).map((f) => `${at(f(N - 1))}\n${at(f(N + 1))}`).join('\n')}
const SAID = JSON.stringify(out);`;
  const got = JSON.parse(said(body));
  Object.keys(CAPPED).forEach((name, i) => {
    assert.match(got[2 * i], /^ok:\d+$/, `${name} at ${N - 1}: ${got[2 * i]}`);
    assert.equal(got[2 * i + 1], `RangeError:${NEST_SAID}`, `${name} at ${N + 1}`);
  });
});

test('the refusal is the same whether or not V8\'s stack would have overflowed, and a core that does not catch it is refused', () => {
  for (const [name, f] of Object.entries(CAPPED)) {
    const near = refusal(`${NEST}\nconst v = ${f(N + 1)};`);
    const far = refusal(`${NEST}\nconst v = ${f(BIG)};`);
    assert.equal(near, `the core failed while loading: ${NEST_SAID}`, `${name} at ${N + 1}`);
    assert.equal(far, near, `${name} at ${BIG}`);
  }
  // a structure with no end: flat(Infinity) of an array that holds itself, join of a chain that never ends in a leaf
  assert.equal(refusal('const a = []; a.push(a); a.flat(Infinity);'), `the core failed while loading: ${NEST_SAID}`);
  assert.equal(refusal('const o = { message: \'\', toString: Error.prototype.toString }; o.name = o; String(o);'), `the core failed while loading: ${NEST_SAID}`);
});

test('the core\'s calls and the data\'s levels share one count', () => {
  const at = (calls, levels) => said(`${NEST}
const f = (k) => (k > 1 ? f(k - 1) : String(nest(${levels}, 1)).length);
let SAID; try { SAID = 'ok:' + f(${calls}); } catch (e) { SAID = e.message; }`);
  assert.match(at(5000, N - 5000 - 10), /^ok:/);
  assert.equal(at(5000, N - 5000 + 10), NEST_SAID);
});

// what V8 answers in the test's own realm, against what the capped built-ins answer in the sandbox: values and errors alike
const SAME = [
  `String([1, [2, [3, [4, []]]], null, undefined, 'x'])`,
  `(() => { const a = [1]; a.push(a, [a, 2]); return String(a) + '|' + a.join(' & ') + '|' + a.toLocaleString(); })()`,
  `[7, [2, [3n]], { toLocaleString() { return 'L'; } }].toLocaleString()`,
  `String(new Error('m')) + String(new TypeError()) + Error.prototype.toString.call({ name: 'N', message: 'M' }) + String(/a\\/b/gi) + RegExp.prototype.toString.call({ source: 's', flags: 'f' })`,
  `(() => { try { Error.prototype.toString.call(1); } catch (e) { return e.constructor.name + e.message; } })()`,
  `Array.prototype.join.length + ',' + Array.prototype.join.name + ',' + JSON.stringify.length + ',' + JSON.parse.length + ',' + [].flat.length + ',' + [].flat.name + ',' + JSON.stringify.name`,
  `JSON.stringify(Object.getOwnPropertyDescriptor(Array.prototype, 'join'), ['writable', 'enumerable', 'configurable']) + JSON.stringify(Object.getOwnPropertyDescriptor(JSON, 'stringify'), ['writable', 'enumerable', 'configurable'])`,
  `JSON.stringify({ a: [1, { b: 2 }], c: 'x', d: undefined, e: () => 1, f: Symbol('s'), g: new Number(3), h: new String('s'), i: new Boolean(false), j: null, k: NaN, l: -0, m: '\\u2028\\ud800' }, null, '  ')`,
  `JSON.stringify({ b: 1, a: { a: 1, b: 2, 1: 3 }, 1: [{ a: 4, z: 5 }] }, ['a', 1, 'b', 'a', new String('z'), new Number(1), {}])`,
  `JSON.stringify([1, { toJSON(k) { return 'k=' + k; } }, { x: { toJSON() { return [1]; } } }])`,
  `JSON.stringify({ a: 1, b: [2, { c: 3 }] }, function (k, v) { return typeof v === 'number' ? v * 10 + (Array.isArray(this) ? 1 : 0) : v; }, 4)`,
  `JSON.stringify(JSON.rawJSON('1e1000')) + JSON.stringify({ r: JSON.rawJSON('"x"') }, ['r'])`,
  `(() => { try { JSON.stringify({ a: 1n }); } catch (e) { return e.constructor.name + e.message; } })()`,
  `(() => { const a = { k: 1 }; a.b = { c: [a] }; try { JSON.stringify(a); } catch (e) { return e.constructor.name + e.message; } })()`,
  `(() => { class K { constructor() { this.self = this; } } try { JSON.stringify(new K()); } catch (e) { return e.message; } })()`,
  `(() => { const log = []; const p = new Proxy({ a: 1, b: 2 }, { get(t, k, r) { log.push('get:' + String(k)); return Reflect.get(t, k, r); }, ownKeys(t) { log.push('keys'); return Reflect.ownKeys(t); } }); return JSON.stringify(p) + JSON.stringify(p, ['b', 'a']) + log.join(); })()`,
  `(() => { const log = []; const o = { get a() { log.push('a'); return { get b() { log.push('b'); return 1; } }; }, get c() { log.push('c'); return 2; } }; return JSON.stringify(o, ['c', 'a', 'b']) + JSON.stringify(o) + log.join(); })()`,
  `(() => { const r = []; const v = JSON.parse('{"a":[1,"x",{"b":2.50,"n":-0}],"c":null,"t":true}', function (k, v, ctx) { r.push([k, typeof v, Object.is(v, -0), JSON.stringify(ctx), Object.getPrototypeOf(ctx) === Object.prototype]); if (k === 'a') this.c = 7; return v; }); return JSON.stringify(r) + JSON.stringify(v); })()`,
  `(() => { const r = []; const v = JSON.parse('[1,[2,3],{"x":[4]}]', function (k, v, ctx) { r.push([k, JSON.stringify(v), JSON.stringify(ctx)]); if (k === '0' && this.length === 3) { this[1][0] = 2; this[1][1] = 9; this[2].x = [4]; this[3] = 'new'; } if (k === '1' && Array.isArray(v)) return undefined; return v; }); return JSON.stringify(r) + JSON.stringify(v); })()`,
  `(() => { try { JSON.parse('[1,', (k, v) => v); } catch (e) { return e.constructor.name + e.message; } })()`,
  `(() => { try { JSON.parse('['.repeat(20000), (k, v) => v); } catch (e) { return e.constructor.name + e.message; } })()`,
  `JSON.stringify(JSON.parse({ toString() { return '{"q":[1]}'; } }, (k, v) => (k === 'q' ? v.concat(2) : v)))`,
  `JSON.stringify(JSON.parse('{"a":1}', 5)) + JSON.stringify(JSON.parse('{"__proto__":1,"b":{"c":"\\\\u0041"}}', (k, v) => v))`,
  `JSON.stringify([[1, [2, [3, [4]]]], , 5].flat()) + JSON.stringify([[1, [2, [3, [4]]]], , 5].flat(2)) + JSON.stringify([[1, [2]]].flat(-1)) + JSON.stringify([[1, [2]]].flat('1')) + JSON.stringify([[[1]]].flat(Infinity))`,
  `JSON.stringify(Array.prototype.flat.call({ length: 3, 0: [1, 2], 2: 3, 1: { length: 1, 0: 9 } })) + JSON.stringify(Array.prototype.flat.call('ab'))`,
  `(() => { class A2 extends Array {} const a = A2.from([[1], [2]]); const f = a.flat(); return f.constructor.name + JSON.stringify(f) + (f instanceof A2); })()`,
  `(() => { const a = [[1]]; a.constructor = { [Symbol.species]: null }; const b = [[1]]; b.constructor = undefined; return JSON.stringify(a.flat()) + JSON.stringify(b.flat()) + Array.isArray(a.flat()); })()`,
  `(() => { const out = []; for (const f of [() => Array.prototype.flat.call(null), () => { const a = [1]; a.constructor = { [Symbol.species]: 1 }; a.flat(); }, () => [1].flat(Symbol())]) { try { f(); } catch (e) { out.push(e.constructor.name + e.message); } } return out.join('|'); })()`,
  `(() => { const log = []; const p = new Proxy([[1], 2], { has(t, k) { log.push('has' + String(k)); return Reflect.has(t, k); }, get(t, k) { log.push('get' + String(k)); return Reflect.get(t, k); } }); return JSON.stringify(p.flat()) + log.join(); })()`,
];

test('under the cap, each capped built-in answers what V8 answers - values, errors and the order it reads in', () => {
  const native = SAME.map((e) => { try { return String((0, eval)(e)); } catch (err) { return `threw ${err.constructor.name}: ${err.message}`; } });
  const sandboxed = JSON.parse(said(`const SAID = JSON.stringify([${SAME.map((e) => `(() => { try { return String(${e}); } catch (err) { return 'threw ' + err.constructor.name + ': ' + err.message; } })()`).join(',\n')}]);`));
  SAME.forEach((e, i) => assert.equal(sandboxed[i], native[i], e));
});

test('a hostile core cannot restore the uncapped built-in or turn the cap off', () => {
  // what it can reach is the capped built-in, wherever it looks; what it replaces of the realm's intrinsics the cap never reads
  const tries = [
    `Int8Array.prototype.toString.call(nest(${BIG}, 1))`,
    `Object.getOwnPropertyDescriptor(Array.prototype, 'join').value.call(nest(${BIG}, 1))`,
    `Reflect.apply(Object.getPrototypeOf([]).join, nest(${BIG}, 1), [])`,
    `(() => { Array.prototype.toString = Array.prototype.toLocaleString; return String(nest(${BIG}, 1)); })()`,
    `(() => { const s = [Reflect.apply, WeakMap.prototype.get, WeakMap.prototype.set, Map.prototype.get, Object.defineProperty, Array.isArray];
      Reflect.apply = () => 'x'; WeakMap.prototype.get = () => 0; WeakMap.prototype.set = function () { return this; }; Map.prototype.get = () => undefined; Object.defineProperty = () => ({}); Array.isArray = () => false;
      try { return JSON.stringify(nest(${BIG}, 1)); } finally { [Reflect.apply, WeakMap.prototype.get, WeakMap.prototype.set, Map.prototype.get, Object.defineProperty, Array.isArray] = s; } })()`,
    `(() => { Object.defineProperty(Object.prototype, 'get', { get() { return () => 1; }, configurable: true }); try { return nest(${BIG}, 1).flat(Infinity); } finally { delete Object.prototype.get; } })()`,
    `(() => { Array.prototype.flat = Array.prototype.flatMap; return JSON.parse('['.repeat(${BIG}) + ']'.repeat(${BIG}), (k, v) => v); })()`,
    `(() => { const was = JSON.stringify; JSON.stringify = JSON.parse; try { const s = Object.getOwnPropertyDescriptor(JSON, 'parse').value; return s('['.repeat(${BIG}) + ']'.repeat(${BIG}), (k, v) => v); } finally { JSON.stringify = was; } })()`,
  ];
  const got = JSON.parse(said(`${NEST}
const SAID = JSON.stringify([${tries.map((t) => `(() => { try { return 'answered ' + String(${t}).length; } catch (e) { return e.message; } })()`).join(',\n')}]);`));
  tries.forEach((t, i) => assert.equal(got[i], NEST_SAID, t));
  // the wrapped built-ins keep their own name and length, and none of them is the original by any route a core has
  const looks = said(`const SAID = [Array.prototype.join, Array.prototype.toLocaleString, Error.prototype.toString, RegExp.prototype.toString, JSON.stringify, JSON.parse, Array.prototype.flat]
  .map((f) => f.name + '/' + f.length + '/' + ('prototype' in f) + '/' + (Object.getPrototypeOf(f) === Object.getPrototypeOf(() => 0))).join(' ');`);
  assert.equal(looks, 'join/1/false/true toLocaleString/0/false/true toString/0/false/true toString/0/false/true stringify/3/false/true parse/2/false/true flat/0/false/true');
});
