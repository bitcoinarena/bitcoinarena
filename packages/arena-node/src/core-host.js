// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE THREAD A CORE RUNS IN (spec §0A.6). Started only by core-sandbox.js, one per core, with the core's files
// already read and checked by the node: it builds the sandbox - an empty vm context, code generation off, the clocks, the
// randomness and the generated code taken out of its own realm, its modules linked to its own files only - and answers
// the node's calls, a JSON string in and a JSON string out. It has no timeout of its own: the node waits for each answer
// against a deadline and ends this whole thread when one is missed. A core that does not stop is ended with its thread,
// never interrupted inside the node's (a vm timeout in a busy node thread was measured aborting the process).
import vm from 'node:vm';
import v8 from 'node:v8';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { workerData } from 'node:worker_threads';

const { files: fileList, entry, name, port, ctrl: ctrlBuffer, arrayBudget, liveCap } = workerData;
const files = new Map(fileList);
const ctrl = new Int32Array(ctrlBuffer);
const DRIVER = readFileSync(new URL('./core-driver.js', import.meta.url), 'utf8');
const REMOVED = ['Date', 'Intl', 'WebAssembly', 'SharedArrayBuffer', 'Atomics', 'eval', 'Function', 'WeakRef', 'FinalizationRegistry', 'console', 'gc'];
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
// changes nothing.
// EVERY CALL THE NODE SIGNS ON RUNS ON A THREAD OF ITS OWN (kanban #1721, #1792, #1831): core-sandbox.js starts one of these
// threads for each meta, runTicks, runTicksFits, replay and decide and ends it after, so nothing a core did in an earlier call
// - its module scope, its intrinsics, the arrays it left - is there in the next. One long-lived thread serves the warm ghost
// (open, pose, stepTo, drop), whose answers nobody signs, and the plugin trial, which runs every call on one thread on purpose
// to see what an adapter keeps. (A context per call in one thread was tried: node 24 never collects a vm.SourceTextModule's
// context - 1.5 MB per context kept after a GC, measured - so the thread died of its heap after a few hundred calls.)
// WHAT THE LONG-LIVED CONTEXT KEEPS is bounded by LIVE_CAP, counted EXACTLY: after a forced GC, the bytes of the arrays
// still reachable (a WeakRef each). Before, it was a FinalizationRegistry count that went down only when a GC happened to
// run, so an honest core that dropped a scratch array per call was ended once the dropped bytes added up (kanban #1721:
// 900 KB per call, ended at the fifth call; #1792: a decide adapter with 40 MB of scratch refused by the trial at its second
// call) - its fate set by GC timing. The cheap upper bound (exact at the last count + allocated since) decides only WHEN
// to count, never the outcome; a count is a GC of this thread, not of the node.
const BUDGET = Number.isInteger(arrayBudget) && arrayBudget > 0 ? arrayBudget : 64 * 1024 * 1024;
// (kanban #1489 merge of #1538 + #1539) a caller may set a tighter cap: the plugin trial uses the budget itself, so a decide
// adapter that keeps its arrays across calls is refused at the array budget, as #1538 promises; 0 or absent keeps 4x the budget
const LIVE_CAP = Number.isInteger(liveCap) && liveCap > 0 ? liveCap : 4 * BUDGET;
/** Past this many arrays tracked since the last count, count again (the WeakRefs are heap of their own). */
const TRACK_MAX = 65536;
// THIS THREAD'S GC (kanban #1721): a worker may not be started with --expose-gc (ERR_WORKER_INVALID_EXEC_ARGV, measured), so
// the flag is set for the moment it takes to read V8's gc from a context made for it, and taken back - a core's context is
// made after, without it ('gc' is in REMOVED besides, for a node started with the flag)
const GC = typeof globalThis.gc === 'function' ? globalThis.gc : (() => {
  v8.setFlagsFromString('--expose-gc');
  try { return vm.runInNewContext('gc'); } finally { v8.setFlagsFromString('--no-expose-gc'); }
})();
const LOCKDOWN = `'use strict';
(() => {
  const budget = ${BUDGET};
  const WR = WeakRef, P = Proxy, R = Reflect, RangeErr = RangeError, M = Map;
  const said = 'the core asked for more than ' + Math.round(budget / 1048576) + ' MB of arrays';
  // what the bookkeeping calls is taken now, before the core can replace a prototype's method or getter: a subclass's own
  // byteLength getter answering 0 or a replaced Map.prototype.set would hide its arrays from the count
  const TA0 = Object.getPrototypeOf(Int8Array.prototype);
  const abLen = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get;
  const taLen = Object.getOwnPropertyDescriptor(TA0, 'byteLength').get;
  const taBuf = Object.getOwnPropertyDescriptor(TA0, 'buffer').get;
  const mSet = M.prototype.set, mDel = M.prototype.delete, mKeys = M.prototype.keys, mGet = M.prototype.get;
  const itNext = Object.getPrototypeOf(new M().keys()).next;
  const deref = WR.prototype.deref;
  const lenOf = (o, ab) => R.apply(ab ? abLen : taLen, o, []);
  const tracked = new M();
  let used = 0, over = null, since = 0, base = 0, nextId = 0, count = 0;
  const take = (n) => { if (over !== null || !(n >= 0) || used + n > budget) { over = said; throw new RangeErr(said); } };
  const keep = (o, n) => {
    used += n; since += n;
    if (n > 0) { R.apply(mSet, tracked, [nextId++, { r: new WR(o), n }]); count++; }
    return o;
  };
  /** The bytes of the arrays still reachable - read by this thread right after a GC, never by the core. */
  const exact = () => {
    let live = 0;
    const it = R.apply(mKeys, tracked, []);
    // a Map's iteration goes on past the entry it deletes; no array of the realm's is used (its prototype is the core's)
    for (let s = R.apply(itNext, it, []); !s.done; s = R.apply(itNext, it, [])) {
      const e = R.apply(mGet, tracked, [s.value]);
      if (R.apply(deref, e.r, []) === undefined) { R.apply(mDel, tracked, [s.value]); count--; } else live += e.n;
    }
    base = live; since = 0;
    return live;
  };
  const KINDS = ['ArrayBuffer', 'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array',
    'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array'];
  const sizeOf = { ArrayBuffer: 1, Int8Array: 1, Uint8Array: 1, Uint8ClampedArray: 1, Int16Array: 2, Uint16Array: 2, Int32Array: 4, Uint32Array: 4,
    Float32Array: 4, Float64Array: 8, BigInt64Array: 8, BigUint64Array: 8 };
  for (const k of KINDS) {
    const K = globalThis[k];
    const W = new P(K, { construct(t, a, nt) {
      // the bytes asked for, before they are allocated: a length, or the length of what is copied in
      const x = a[0];
      const asked = typeof x === 'number' ? x * sizeOf[k] : (x && typeof x === 'object' && !(x instanceof ArrayBuffer) && typeof x.length === 'number') ? x.length * sizeOf[k] : 0;
      take(asked);
      const o = R.construct(t, a, nt === W ? t : nt);
      if (k !== 'ArrayBuffer' && R.apply(taBuf, o, []) === x) return o;   // a view on a buffer already counted
      const got = lenOf(o, k === 'ArrayBuffer');
      take(got - asked > 0 ? got - asked : 0);
      return keep(o, got);
    } });
    Object.defineProperty(K.prototype, 'constructor', { value: W, writable: false, configurable: false });
    globalThis[k] = W;
  }
  for (const m of ['transfer', 'transferToFixedLength', 'resize']) delete ArrayBuffer.prototype[m];
  for (const m of ['toReversed', 'toSorted', 'with']) {
    const f = TA0[m];
    Object.defineProperty(TA0, m, { value: function (...a) { take(R.apply(taLen, this, [])); const o = R.apply(f, this, a); return keep(o, lenOf(o, false)); }, writable: false, configurable: false });
  }
  for (const k of ${JSON.stringify(REMOVED)}) delete globalThis[k];
  delete Math.random;
  Object.defineProperty(Error, 'prepareStackTrace', { value: undefined, writable: false, configurable: false });
  // the script's value, handed only to this thread and kept on no global: the core never reaches it
  return Object.freeze({ begin() { used = 0; }, over: () => over, used: () => used,
    bound: () => (count > ${TRACK_MAX} ? Infinity : base + since), exact });
})();`;

/** Answer the node: the message first, then the flag it waits on. */
function answer(m) {
  port.postMessage(m);
  Atomics.store(ctrl, 0, 1);
  Atomics.notify(ctrl, 0);
}
const said = (e) => (e && typeof e.message === 'string' ? e.message : String(e));

// compiled once, run in every context: the lockdown, the call, and a code cache of each module's source
const LOCKDOWN_SCRIPT = new vm.Script(LOCKDOWN, { filename: 'arena:lockdown' });
const CALL_SCRIPT = new vm.Script('__arenaCall(__arenaOp, __arenaIn)', { filename: 'arena:call' });
const codeCache = new Map();

/** ONE CONTEXT, LOADED FROM THE CORE'S FILES: the lockdown, the core's modules and the driver evaluated in it. Answers
 *  { run(op, json), budget }. Throws when the core does not load. */
function build() {
  if (typeof vm.SourceTextModule !== 'function') throw new Error('the core thread was started without --experimental-vm-modules');
  // DONT_CONTEXTIFY: the context's global is its own ordinary object, not one of this thread's behind interceptors -
  // nothing of the node stands behind it, and a core's global reads run at full speed (measured 4x slower behind them)
  const context = vm.createContext(vm.constants.DONT_CONTEXTIFY, {
    name: `core ${name}`, codeGeneration: { strings: false, wasm: false }, microtaskMode: 'afterEvaluate',
  });
  const budget = LOCKDOWN_SCRIPT.runInContext(context);
  const modules = new Map();
  const compile = (key, text, identifier) => {
    const m = new vm.SourceTextModule(text, { context, identifier, cachedData: codeCache.get(key) });
    if (!codeCache.has(key)) codeCache.set(key, m.createCachedData());
    return m;
  };
  const moduleOf = (rel) => {
    if (!modules.has(rel)) modules.set(rel, compile(rel, files.get(rel), `core:/${rel}`));
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
  const driver = compile('\0arena:driver', DRIVER, 'arena:driver');
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
  const run = (op, json) => {
    budget.begin();
    context.__arenaOp = op; context.__arenaIn = json;
    const out = CALL_SCRIPT.runInContext(context);
    if (budget.over() !== null) throw new Error(budget.over());
    return out;
  };
  return { run, budget };
}

let loaded = false;
let warm = null;     // the core's context: loaded again after it was dropped (past its array budget, or LIVE_CAP)
try { warm = build(); loaded = true; answer({ ok: true }); } catch (e) { answer({ ok: false, why: said(e) }); }

port.on('message', ({ op, json }) => {
  if (!loaded) return answer({ ok: false, why: 'the core did not load' });
  op = String(op);
  let box;
  try { box = warm || (warm = build()); } catch (e) { return answer({ ok: false, why: `the core failed in ${op}: ${said(e)}` }); }
  let out, why = null;
  try { out = box.run(op, String(json)); } catch (e) { why = `the core failed in ${op}: ${said(e)}`; }
  if (why === null && typeof out !== 'string') why = `the core answered ${op} with something other than JSON`;
  const reply = why === null ? { ok: true, json: out } : { ok: false, why };
  // past its array budget the context is dropped - the core could have caught the refusal and kept what it held
  if (box.budget.over() !== null) { if (warm === box) warm = null; answer(reply); setImmediate(GC); return; }
  if (box.budget.bound() <= LIVE_CAP) return answer(reply);
  // kanban #1539, #1721: what the context keeps alive across calls, counted EXACTLY - in the next turn of this thread (the
  // WeakRefs a call made hold their arrays until its job is over), after a full GC - and never by the core: past LIVE_CAP
  // the context is dropped (its arrays with it), an end and not a value the core can branch on
  setImmediate(() => {
    GC();
    const live = box.budget.exact();
    if (live > LIVE_CAP) {
      if (warm === box) warm = null;
      answer({ ok: false, why: `the core failed in ${op}: it kept more than ${Math.round(LIVE_CAP / 1048576)} MB of arrays alive` });
      setImmediate(GC);
      return;
    }
    answer(reply);
  });
});
