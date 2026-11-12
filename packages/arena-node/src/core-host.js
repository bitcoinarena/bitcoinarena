// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE THREAD A CORE RUNS IN (spec §0A.6). Started only by core-sandbox.js, one per core, with the core's files
// already read and checked by the node: it builds the sandbox - an empty vm context, code generation off, the clocks, the
// randomness and the generated code taken out of its own realm, its modules linked to its own files only - and answers
// the node's calls, a JSON string in and a JSON string out. It has no timeout of its own: the node waits for each answer
// against a deadline and ends this whole thread when one is missed. A core that does not stop is ended with its thread,
// never interrupted inside the node's (a vm timeout in a busy node thread was measured aborting the process).
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { workerData } from 'node:worker_threads';

const { files: fileList, entry, name, port, ctrl: ctrlBuffer, arrayBudget, liveCap, answerMax } = workerData;
const files = new Map(fileList);
const ctrl = new Int32Array(ctrlBuffer);
const DRIVER = readFileSync(new URL('./core-driver.js', import.meta.url), 'utf8');
const REMOVED = ['Date', 'Intl', 'WebAssembly', 'SharedArrayBuffer', 'Atomics', 'eval', 'Function', 'WeakRef', 'FinalizationRegistry', 'console'];
// run in the context before any core code: what the core must not have is taken out of its own realm
// THE ARRAY BUDGET: a core's typed arrays and ArrayBuffers live outside the V8 heap, so the thread's heap limit
// does not bound them (measured: 9.3 GB in 8 s past a 256 MB heap limit). Every constructor of them in the core's realm is
// wrapped before the core loads - as the global and as each prototype's \`constructor\`, so \`slice\`, \`map\`, \`filter\`, \`from\`
// (the species path) are counted too - and the allocation that would take the bytes alive past the budget throws. The
// copies made without a constructor (toReversed, toSorted, with) are counted the same way; transfer, transferToFixedLength
// and resize, which grow a buffer without one, are taken out.
// THE BUDGET IS PER CALL (kanban #1539): it counts the bytes allocated since the call began (the load, for the top level),
// never the bytes still alive - those come back only after a GC, whenever one runs, so a core that tried an allocation near
// the budget and caught the RangeError read what earlier calls on its thread left uncollected: the same call on the same
// input answered 10 on a fresh thread and 9 after one call (measured), and committee seats with different histories would
// split on one round. Crossing the budget is sticky: the call fails whatever the core does with the error, so catching it
// changes nothing. What stays alive across calls is still bounded - by LIVE_CAP, read only by this thread between calls,
// which ends the core and never hands the core a value.
const BUDGET = Number.isInteger(arrayBudget) && arrayBudget > 0 ? arrayBudget : 64 * 1024 * 1024;
// (kanban #1489 merge of #1538 + #1539) a caller may set a tighter cap: the plugin trial uses the budget itself, so a decide
// adapter that keeps its arrays across calls is refused at the array budget, as #1538 promises; 0 or absent keeps 4x the budget
const LIVE_CAP = Number.isInteger(liveCap) && liveCap > 0 ? liveCap : 4 * BUDGET;
// THE ANSWER'S SIZE (kanban #1691): the node copies each answer into its own thread and parses it there, outside every limit
// this thread has - the driver calls JSON.stringify as the core left it, so a core could answer a 32 MB '[0,0,...]' for one
// String.prototype.repeat (measured: the node's thread held 7.3 s, its heap +800 MB). An answer longer than ANSWER_MAX is
// never posted: the core is ended, as at LIVE_CAP. `out` is a primitive string checked in this thread's realm, its length no
// property the core can change.
const ANSWER_MAX = Number.isInteger(answerMax) && answerMax > 0 ? answerMax : 4 * 1024 * 1024;
const LOCKDOWN = `'use strict';
(() => {
  const budget = ${BUDGET};
  const FR = FinalizationRegistry, P = Proxy, RangeErr = RangeError;
  // kanban #1695: every intrinsic the count reads is taken here, before any core code runs, and never looked up again - a core
  // that redefines %TypedArray%.prototype.byteLength, gives a source its own \`length\` or replaces Reflect.construct changes
  // nothing the wrapper reads, and never receives the raw constructor. Lengths are read through the captured getters, and an
  // allocation is counted by the real byte length of what was made, never by the figure asked for.
  const construct = Reflect.construct, apply = Reflect.apply, gd = Object.getOwnPropertyDescriptor;
  const uncurry = (f) => (o) => apply(f, o, []);
  const TAP = Object.getPrototypeOf(Int8Array.prototype);
  const taLength = uncurry(gd(TAP, 'length').get), taBytes = uncurry(gd(TAP, 'byteLength').get), taBuffer = uncurry(gd(TAP, 'buffer').get);
  const abBytes = uncurry(gd(ArrayBuffer.prototype, 'byteLength').get);
  const register = FR.prototype.register;
  const lengthOf = (x) => { try { return taLength(x); } catch { return null; } };
  const isBuffer = (x) => { try { abBytes(x); return true; } catch { return false; } };
  const said = 'the core asked for more than ' + Math.round(budget / 1048576) + ' MB of arrays';
  let used = 0, live = 0, over = null;
  const back = new FR((n) => { live -= n; });
  const take = (n) => { if (over !== null || !(n >= 0) || used + n > budget) { over = said; throw new RangeErr(said); } };
  const keep = (o, n) => { used += n; live += n; apply(register, back, [o, n]); return o; };
  // (kanban #1622) the kinds are read from the realm itself, never from a list: every own global whose prototype chain
  // reaches %TypedArray% (Float16Array on node 24 was missing from the old list and allocated outside the budget and the
  // live cap), plus ArrayBuffer - so a typed-array kind a later V8 adds is wrapped too. Its size is its BYTES_PER_ELEMENT.
  const TA0 = Object.getPrototypeOf(Int8Array);
  const KINDS = ['ArrayBuffer'], sizeOf = { ArrayBuffer: 1 };
  for (const k of Object.getOwnPropertyNames(globalThis)) {
    const d = Object.getOwnPropertyDescriptor(globalThis, k), K = d && d.value;
    if (typeof K !== 'function' || K === TA0) continue;
    let p = Object.getPrototypeOf(K);
    while (p !== null && p !== TA0) p = Object.getPrototypeOf(p);
    if (p !== TA0) continue;
    const b = K.BYTES_PER_ELEMENT;
    if (!Number.isInteger(b) || b < 1) throw new RangeErr('the typed array kind ' + k + ' has no element size');
    KINDS.push(k); sizeOf[k] = b;
  }
  for (const k of KINDS) {
    const K = globalThis[k], size = sizeOf[k], bytesOf = k === 'ArrayBuffer' ? abBytes : taBytes;
    const W = new P(K, { construct(t, a, nt) {
      // the bytes asked for, before they are allocated: a length, or the length of what is copied in (a typed array's own,
      // read through the captured getter as V8 reads it; an array-like's \`length\` is only a first guess, counted again below)
      const x = a[0];
      const n = typeof x === 'number' ? x : lengthOf(x);
      const asked = typeof n === 'number' ? n * size
        : (x && typeof x === 'object' && !isBuffer(x) && typeof x.length === 'number') ? x.length * size : 0;
      take(asked);
      const o = construct(t, a, nt === W ? t : nt);
      if (k !== 'ArrayBuffer' && isBuffer(x) && taBuffer(o) === x) return o;   // a view on a buffer already counted
      const real = bytesOf(o);
      take(real - asked > 0 ? real - asked : 0);
      return keep(o, real);
    } });
    Object.defineProperty(K.prototype, 'constructor', { value: W, writable: false, configurable: false });
    globalThis[k] = W;
  }
  for (const m of ['transfer', 'transferToFixedLength', 'resize']) delete ArrayBuffer.prototype[m];
  for (const m of ['toReversed', 'toSorted', 'with']) {
    const f = TAP[m];
    Object.defineProperty(TAP, m, { value: function (...a) { take(taBytes(this)); const o = apply(f, this, a); return keep(o, taBytes(o)); }, writable: false, configurable: false });
  }
  for (const k of ${JSON.stringify(REMOVED)}) delete globalThis[k];
  delete Math.random;
  // THE SEAT'S LOCALE (kanban #1623): Intl is gone, but the locale-aware methods of the language still answer by the
  // thread's ICU default locale - the seat's LANG/LC_ALL (measured: '1,234.5|äz' under en_US, '1 234,5|zä' under sv_SE),
  // so one run hashed differently on seats with different locales. Each is replaced by its locale-free twin: toLocaleString
  // is toString (Array, TypedArray and Object's call the elements' own, so they follow), the case methods are the
  // locale-free ones, localeCompare compares code units. The same answer on every seat, whatever its locale.
  const lockLocale = (o, m, f) => Object.defineProperty(o, m, { value: f, writable: false, configurable: false, enumerable: false });
  const nToS = Number.prototype.toString, bToS = BigInt.prototype.toString;
  const up = String.prototype.toUpperCase, low = String.prototype.toLowerCase;
  lockLocale(Number.prototype, 'toLocaleString', { toLocaleString() { return apply(nToS, this, []); } }.toLocaleString);
  lockLocale(BigInt.prototype, 'toLocaleString', { toLocaleString() { return apply(bToS, this, []); } }.toLocaleString);
  const strOf = (s) => { if (s === null || s === undefined) throw new TypeError('String.prototype method called on null or undefined'); return String(s); };
  lockLocale(String.prototype, 'toLocaleUpperCase', { toLocaleUpperCase() { return apply(up, strOf(this), []); } }.toLocaleUpperCase);
  lockLocale(String.prototype, 'toLocaleLowerCase', { toLocaleLowerCase() { return apply(low, strOf(this), []); } }.toLocaleLowerCase);
  lockLocale(String.prototype, 'localeCompare', { localeCompare(that) {
    const a = strOf(this), b = String(that);
    return a < b ? -1 : a > b ? 1 : 0;
  } }.localeCompare);
  Object.defineProperty(Error, 'prepareStackTrace', { value: undefined, writable: false, configurable: false });
  // the script's value, handed only to this thread and kept on no global: the core never reaches it
  return Object.freeze({ begin() { used = 0; }, over: () => over, live: () => live });
})();`;

/** Answer the node: the message first, then the flag it waits on. */
function answer(m) {
  port.postMessage(m);
  Atomics.store(ctrl, 0, 1);
  Atomics.notify(ctrl, 0);
}
const said = (e) => (e && typeof e.message === 'string' ? e.message : String(e));

let liveOf = () => 0;
function load() {
  if (typeof vm.SourceTextModule !== 'function') throw new Error('the core thread was started without --experimental-vm-modules');
  // DONT_CONTEXTIFY: the context's global is its own ordinary object, not one of this thread's behind interceptors -
  // nothing of the node stands behind it, and a core's global reads run at full speed (measured 4x slower behind them)
  const context = vm.createContext(vm.constants.DONT_CONTEXTIFY, {
    name: `core ${name}`, codeGeneration: { strings: false, wasm: false }, microtaskMode: 'afterEvaluate',
  });
  const budget = new vm.Script(LOCKDOWN, { filename: 'arena:lockdown' }).runInContext(context);
  const modules = new Map();
  const moduleOf = (rel) => {
    if (!modules.has(rel)) modules.set(rel, new vm.SourceTextModule(files.get(rel), { context, identifier: `core:/${rel}` }));
    return modules.get(rel);
  };
  // THE GATE: a relative path inside the hashed files, and nothing else
  const resolve = (specifier, fromRel) => {
    if (!/^\.\.?\//.test(specifier)) throw new Error(`the core imports "${specifier}", and a core may import only its own files`);
    const rel = posix.normalize(posix.join(posix.dirname(fromRel), specifier));
    if (rel.startsWith('../') || !files.has(rel)) throw new Error(`the core imports "${specifier}", which is not one of its hashed files`);
    return rel;
  };
  const linked = new Set();
  const link = (rel) => {
    if (linked.has(rel)) return;
    linked.add(rel);
    const m = moduleOf(rel);
    const deps = m.moduleRequests.map((r) => resolve(r.specifier, rel));
    m.linkRequests(deps.map(moduleOf));
    for (const d of deps) link(d);
  };
  link(entry);
  const driver = new vm.SourceTextModule(DRIVER, { context, identifier: 'arena:driver' });
  for (const r of driver.moduleRequests) if (r.specifier !== 'arena:core') throw new Error('the driver imports only the core');
  driver.linkRequests([moduleOf(entry)]);
  driver.instantiate();
  const evaluated = driver.evaluate();
  if (evaluated && typeof evaluated.catch === 'function') evaluated.catch(() => { /* said below, by status */ });
  if (budget.over() !== null) throw new Error(`the core failed while loading: ${budget.over()}`);
  if (driver.status === 'errored') throw new Error(`the core failed while loading: ${said(driver.error)}`);
  if (driver.status !== 'evaluated') throw new Error('the core did not finish loading (a core may not wait on anything)');
  // EVERY CALL IS A SCRIPT RUN IN THE CONTEXT, so its microtasks run after it, inside the node's deadline (microtaskMode
  // afterEvaluate) - the driver's door and the two strings it is handed sit on the context's own global
  Object.defineProperty(context, '__arenaCall', { value: driver.namespace.call, writable: false, configurable: false, enumerable: false });
  const script = new vm.Script('__arenaCall(__arenaOp, __arenaIn)', { filename: 'arena:call' });
  liveOf = budget.live;
  return (op, json) => {
    budget.begin();
    context.__arenaOp = op; context.__arenaIn = json;
    const out = script.runInContext(context);
    if (budget.over() !== null) throw new Error(budget.over());
    return out;
  };
}

let call = null;
try { call = load(); answer({ ok: true }); } catch (e) { answer({ ok: false, why: said(e) }); }

port.on('message', ({ op, json }) => {
  if (!call) return answer({ ok: false, why: 'the core did not load' });
  let out;
  try { out = call(String(op), String(json)); } catch (e) { return answer({ ok: false, why: `the core failed in ${op}: ${said(e)}` }); }
  // kanban #1539: the arrays a core keeps alive across calls, read here between calls and never by the core: past LIVE_CAP
  // the core is ended (its context dropped, its arrays with it) - an end, not a value the core can branch on
  if (liveOf() > LIVE_CAP) {
    call = null; liveOf = () => 0;
    return answer({ ok: false, why: `the core failed in ${op}: it kept more than ${Math.round(LIVE_CAP / 1048576)} MB of arrays alive` });
  }
  if (typeof out !== 'string') return answer({ ok: false, why: `the core answered ${op} with something other than JSON` });
  if (out.length > ANSWER_MAX) {
    call = null; liveOf = () => 0;
    return answer({ ok: false, why: `the core failed in ${op}: its answer was longer than ${Math.round(ANSWER_MAX / 1048576)} MB` });
  }
  answer({ ok: true, json: out });
});
