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
import { getHeapStatistics } from 'node:v8';

const { files: fileList, entry, name, port, ctrl: ctrlBuffer, arrayBudget, liveCap, answerMax } = workerData;
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
// THE ANSWER'S SIZE (kanban #1691): the node copies each answer into its own thread and parses it there, outside every limit
// this thread has - the driver calls JSON.stringify as the core left it, so a core could answer a 32 MB '[0,0,...]' for one
// String.prototype.repeat (measured: the node's thread held 7.3 s, its heap +800 MB). An answer longer than ANSWER_MAX is
// never posted: the core is ended, as at LIVE_CAP. `out` is a primitive string checked in this thread's realm, its length no
// property the core can change.
const ANSWER_MAX = Number.isInteger(answerMax) && answerMax > 0 ? answerMax : 4 * 1024 * 1024;
/** Past this many arrays tracked since the last count, count again (the WeakRefs are heap of their own). */
const TRACK_MAX = 65536;
// THIS THREAD'S GC (kanban #1721): a worker may not be started with --expose-gc (ERR_WORKER_INVALID_EXEC_ARGV, measured), so
// the flag is set for the moment it takes to read V8's gc from a context made for it, and taken back - a core's context is
// made after, without it ('gc' is in REMOVED besides, for a node started with the flag)
// THE FLAG IS THE PROCESS'S (kanban #1489, merge of #1721 with #1813's concurrent cores): another core thread taking it back at the same
// moment left this one's context without gc ("gc is not defined", the core's load failed) - so it is asked again a few times
const GC = typeof globalThis.gc === 'function' ? globalThis.gc : (() => {
  for (let tries = 0; tries < 50; tries++) {
    v8.setFlagsFromString('--expose-gc');
    try { const g = vm.runInNewContext("typeof gc === 'function' ? gc : null"); if (g) return g; } finally { v8.setFlagsFromString('--no-expose-gc'); }
  }
  throw new Error('this core thread could not read V8\'s gc');
})();
// THE SEAT'S V8 FLAGS (kanban #2453, #1489 audit44 refute of #1623): flags are process-wide, so the core thread's realm starts
// with what the operator's NODE_OPTIONS or node command line set - --expose-gc put a \`gc\` global into the context and
// --stack-trace-limit=50 started Error.stackTraceLimit at 50 (a core's 30-deep stack listed 36 lines against 11), and one core on
// one input hashed differently on seats of one committee. Every own global of the context that is not on this fixed list of the
// language's globals is taken out (gc, and any global a flag or a later Node adds, Temporal under --harmony-temporal), and
// Error.stackTraceLimit starts at V8's default 10 on every seat (the core may still write it). The globals V8's extension
// flags install (gc, externalizeString, ...) are not configurable and cannot be deleted, so this thread turns those flags off
// before it makes the core's context (V8_EXTENSIONS_OFF): flags are read when a context is made, so the node's own realm and its
// gc stay as the operator started them. A foreign global that still cannot be taken out stops the core from loading, by name.
const V8_EXTENSIONS_OFF = '--no-expose-gc --no-expose-externalize-string --no-expose-statistics --no-expose-trigger-failure '
  + '--no-expose-ignition-statistics --expose-cputracemark-as=';
const GLOBALS = ['Object', 'Function', 'Array', 'Number', 'parseFloat', 'parseInt', 'Infinity', 'NaN', 'undefined', 'Boolean', 'String',
  'Symbol', 'Date', 'Promise', 'RegExp', 'Error', 'AggregateError', 'EvalError', 'RangeError', 'ReferenceError', 'SyntaxError',
  'TypeError', 'URIError', 'SuppressedError', 'globalThis', 'JSON', 'Math', 'Intl', 'ArrayBuffer', 'Atomics', 'Uint8Array', 'Int8Array',
  'Uint16Array', 'Int16Array', 'Uint32Array', 'Int32Array', 'BigUint64Array', 'BigInt64Array', 'Uint8ClampedArray', 'Float16Array',
  'Float32Array', 'Float64Array', 'DataView', 'Map', 'BigInt', 'Set', 'Iterator', 'WeakMap', 'WeakSet', 'Proxy', 'Reflect',
  'FinalizationRegistry', 'WeakRef', 'DisposableStack', 'AsyncDisposableStack', 'decodeURI', 'decodeURIComponent', 'encodeURI',
  'encodeURIComponent', 'escape', 'unescape', 'eval', 'isFinite', 'isNaN', 'console', 'SharedArrayBuffer', 'WebAssembly'];
const LOCKDOWN = `'use strict';
(() => {
  const budget = ${BUDGET};
  const WR = WeakRef, P = Proxy, R = Reflect, RangeErr = RangeError, M = Map;
  // kanban #1695: every intrinsic the count reads is taken here, before any core code runs, and never looked up again - a core
  // that redefines %TypedArray%.prototype.byteLength, gives a source its own \`length\` or replaces Reflect.construct changes
  // nothing the wrapper reads, and never receives the raw constructor. Lengths are read through the captured getters, and an
  // allocation is counted by the real byte length of what was made, never by the figure asked for.
  const construct = Reflect.construct, apply = Reflect.apply, gd = Object.getOwnPropertyDescriptor;
  const uncurry = (f) => (o) => apply(f, o, []);
  const TAP = Object.getPrototypeOf(Int8Array.prototype);
  const taLength = uncurry(gd(TAP, 'length').get), taBytes = uncurry(gd(TAP, 'byteLength').get), taBuffer = uncurry(gd(TAP, 'buffer').get);
  const abBytes = uncurry(gd(ArrayBuffer.prototype, 'byteLength').get);
  const lengthOf = (x) => { try { return taLength(x); } catch { return null; } };
  // (kanban #2475, #2508) what the wrapper copies an iterable or array-like source with, all taken before any core code
  const dp = Object.defineProperty, iterSym = Symbol.iterator, trunc = Math.trunc, TypeErr = TypeError, MAX_LEN = 9007199254740991;
  const toLength = (v) => { const n = +v; return n > 0 ? (n === Infinity ? MAX_LEN : trunc(n) < MAX_LEN ? trunc(n) : MAX_LEN) : 0; };
  const isObj = (v) => (v !== null && typeof v === 'object') || typeof v === 'function';
  const isBuffer = (x) => { try { abBytes(x); return true; } catch { return false; } };
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
  // (kanban #2449, #2496) take() RESERVES: the bytes count from the moment they are taken, before the allocation and before
  // any core code that runs between it and its return (a map callback, a toSorted comparator, a nested call) - so a copy
  // whose method never returns stays counted, and a nested take() sees every level above it. settle() moves a reservation
  // to the real byte length once the allocation is known; keep() only marks the object alive (the live count, #1813).
  const take = (n) => { if (over !== null || !(n >= 0) || used + n > budget) { over = said; throw new RangeErr(said); } used += n; };
  const settle = (reserved, real) => { if (real > reserved) take(real - reserved); else used -= reserved - real; };
  // (kanban #2145, #2211) every object the count has taken, so a copy counted by a wrapped constructor is never counted twice
  const counted = new WeakSet(), wsAdd = WeakSet.prototype.add, wsHas = WeakSet.prototype.has;
  const isCounted = (o) => R.apply(wsHas, counted, [o]);
  const keep = (o, n) => {
    since += n;
    if (n > 0) { R.apply(mSet, tracked, [nextId++, { r: new WR(o), n }]); count++; }
    R.apply(wsAdd, counted, [o]);
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
  // (kanban #2475) the budget checked without reserving: IteratorToList below reads the elements before anything is allocated
  const fits = (n) => { if (over !== null || !(n >= 0) || used + n > budget) { over = said; throw new RangeErr(said); } };
  // IteratorToList, as %TypedArray% runs it, into a list of our own - each element's bytes checked as it comes, so an endless
  // or oversized iterable stops at the budget, never at the heap
  const listOf = (x, m, size) => {
    const it = apply(m, x, []);
    if (!isObj(it)) throw new TypeErr('Result of the Symbol.iterator method is not an object');
    const next = it.next, list = [];
    for (let n = 0; ; n++) {
      const r = apply(next, it, []);
      if (!isObj(r)) throw new TypeErr('Iterator result ' + String(r) + ' is not an object');
      if (r.done) return { list, len: n };
      fits((n + 1) * size);
      dp(list, n, { value: r.value, writable: true, enumerable: true, configurable: true });
    }
  };
  // (kanban #1622) the kinds are read from the realm itself, never from a list: every own global whose prototype chain
  // reaches %TypedArray% (Float16Array on node 24 was missing from the old list and allocated outside the budget and the
  // live cap), plus ArrayBuffer - so a typed-array kind a later V8 adds is wrapped too. Its size is its BYTES_PER_ELEMENT.
  const TAC = Object.getPrototypeOf(Int8Array);
  const KINDS = ['ArrayBuffer'], sizeOf = { ArrayBuffer: 1 };
  for (const k of Object.getOwnPropertyNames(globalThis)) {
    const d = Object.getOwnPropertyDescriptor(globalThis, k), K = d && d.value;
    if (typeof K !== 'function' || K === TAC) continue;
    let p = Object.getPrototypeOf(K);
    while (p !== null && p !== TAC) p = Object.getPrototypeOf(p);
    if (p !== TAC) continue;
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
      // (kanban #2475, #2508; #1489 a44 refute of #1695) AN ITERABLE OR ARRAY-LIKE SOURCE IS COPIED HERE, NEVER BY V8: V8 read
      // its length again after the wrapper (a core's getter answered 0 to the wrapper and N to V8), allocated N, and then ran the
      // core's element getters and valueOf - after the allocation - so one that threw skipped the count below: 8 x 32 MB past a
      // 4 MB budget answered, and a 512 MB one was stopped only by the RSS backstop. The spec's steps, in its order, on one length
      // read (or the list the iterator gave): the bytes taken and the empty array counted before the first element is read.
      if (k !== 'ArrayBuffer' && n === null && isObj(x) && !isBuffer(x)) {
        const m = x[iterSym];
        let src, len;
        if (m !== undefined && m !== null) {
          if (typeof m !== 'function') throw new TypeErr('Symbol.iterator is not a function');
          ({ list: src, len } = listOf(x, m, size));
        } else { src = x; len = toLength(x.length); }
        take(len * size);
        const o = construct(t, [len], nt === W ? t : nt);
        const real = bytesOf(o);
        settle(len * size, real);
        keep(o, real);
        for (let i = 0; i < len; i++) o[i] = src[i];
        return o;
      }
      const asked = typeof n === 'number' ? n * size : 0;
      take(asked);
      const o = construct(t, a, nt === W ? t : nt);
      if (k !== 'ArrayBuffer' && isBuffer(x) && taBuffer(o) === x) return o;   // a view on a buffer already counted
      const real = bytesOf(o);
      settle(asked, real);
      return keep(o, real);
    } });
    Object.defineProperty(K.prototype, 'constructor', { value: W, writable: false, configurable: false });
    globalThis[k] = W;
  }
  for (const m of ['transfer', 'transferToFixedLength', 'resize']) delete ArrayBuffer.prototype[m];
  // AND EVERY STATIC FACTORY OF A TYPED ARRAY KIND THAT IS NOT from/of (feedback #024, kanban #2567): from/of build through \`this\` - the wrapped
  // constructor, so they are counted - but a factory such as Uint8Array.fromHex / fromBase64 (V8 13.x+, not in node 24.22) allocates on the original,
  // outside the budget and the live cap. Removed wherever the runtime has them, so a newer node cannot open the hole.
  for (const k of KINDS) for (const m of ['fromHex', 'fromBase64']) { try { delete globalThis[k][m]; } catch { /* none */ } try { delete Object.getPrototypeOf(globalThis[k])[m]; } catch { /* none */ } }
  // THE SPECIES FALLBACK (kanban #2145, #2211, a44 refute of #1622): slice, map and filter of a typed array and slice of an
  // ArrayBuffer make their copy through the species path, and that path falls back to the realm's RAW intrinsic when the
  // exemplar's own \`constructor\` is undefined or has no @@species (ECMA-262 TypedArraySpeciesCreate, SpeciesConstructor) -
  // a core that ran Object.defineProperty(a, 'constructor', { value: undefined }) copied outside the budget and the live
  // cap. So the count no longer depends on the species lookup: each method is wrapped, and a copy the wrapped constructors
  // did not already count (or a view on a buffer they counted) is counted here by its real byte length.
  const copied = (o, bytesOf) => {
    if (o === null || typeof o !== 'object' || isCounted(o)) return o;
    if (bytesOf === taBytes) { let b = null; try { b = taBuffer(o); } catch { return o; } if (isCounted(b)) return o; }
    else if (!isBuffer(o)) return o;
    const n = bytesOf(o);
    take(n);
    return keep(o, n);
  };
  // slice and filter run no core code after their copy is allocated (filter calls its callbacks before), so counting the copy
  // when they return is counting it before any core code can run beside it
  for (const [O, m, bytesOf] of [[TAP, 'slice', taBytes], [TAP, 'filter', taBytes], [ArrayBuffer.prototype, 'slice', abBytes]]) {
    const f = O[m];
    Object.defineProperty(O, m, { value: { [m](...a) { return copied(apply(f, this, a), bytesOf); } }[m], writable: false, configurable: false });
  }
  // (kanban #2449, #2496) map allocates its copy FIRST and then calls the core's callback once per element: a callback that
  // throws (or nests another map) left the copy uncounted. So the copy is made by the raw map with a callback that runs no
  // core code, counted at once, and only then filled by the core's callback, in the order ECMA-262 %TypedArray%.prototype.map
  // gives (Get, Call, Set per index): the same values, the same errors, the copy counted before the first callback runs.
  {
    const f = TAP.map, same = (v) => v;
    Object.defineProperty(TAP, 'map', { value: { map(cb, ...rest) {
      const thisArg = rest[0];
      const len = taLength(this);
      if (typeof cb !== 'function') throw new TypeError(String(cb) + ' is not a function');
      const A = copied(apply(f, this, [same]), taBytes);
      for (let k = 0; k < len; k++) A[k] = apply(cb, thisArg, [this[k], k, this]);
      return A;
    } }.map, writable: false, configurable: false });
  }
  // toReversed, toSorted and with copy without a constructor; the copy's bytes are reserved before it is made (the toSorted
  // comparator and with's value coercion are core code) and settled to its real length after
  for (const m of ['toReversed', 'toSorted', 'with']) {
    const f = TAP[m];
    Object.defineProperty(TAP, m, { value: { [m](...a) { const r = taBytes(this); take(r); const o = apply(f, this, a); const real = taBytes(o); settle(r, real); return keep(o, real); } }[m], writable: false, configurable: false });
  }
  // a global the context cannot lose (V8's gc, made non-configurable while ANOTHER thread of this process had --expose-gc set for
  // the moment core-host.js takes to read it - the flag is the process's) is no context to run a core in: it is made again (build)
  for (const k of ${JSON.stringify(REMOVED)}) if (!R.deleteProperty(globalThis, k)) throw new RangeErr('arena:context-again ' + k);
  // kanban #2453: only the language's own globals stay, whatever the seat's V8 flags added (one that cannot be taken out
  // stops the load), and the stack trace limit starts the same on every seat
  const language = new Set(${JSON.stringify(GLOBALS)});
  for (const k of Reflect.ownKeys(globalThis)) {
    if (typeof k === 'string' && language.has(k)) continue;
    if (!Reflect.deleteProperty(globalThis, k)) throw new TypeError("the seat's node put the global " + String(k) + " into the core's realm, and it cannot be taken out");
  }
  Error.stackTraceLimit = 10;
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
  // THE SEAT'S INSTALL PATH (kanban #2219, #1489 audit44 refute of #1623): V8's default stack text lists this thread's own
  // frames below the core's - file:///<install dir>/packages/arena-node/src/core-host.js and node:vm with its line numbers -
  // so a core that put any bit of new Error().stack in its hash or result answered differently on seats installed in
  // different directories (measured: 625 against 675 characters for /a and /operator-bob/bitcoin-arena), and read the
  // operator's user name and the Node build. The stack text is formatted here instead: the error's own head, then the frames
  // of the core's realm (core:/<file>, arena:driver, arena:call, arena:lockdown, and built-ins with no file) from the top
  // down to the first frame of anything else, which ends it. The node's frames are never in it, whatever the seat's path or
  // Node build. Error.stackTraceLimit stays the core's to set (a core may write it): a higher one shows more of the core's own
  // frames, the same on every seat, and never one of the node's. The global Error binding is fixed: Node formats a
  // stack by globalThis.Error.prepareStackTrace of the error's realm, so a core that replaced the global Error by an object
  // of its own would be handed the call sites again. Error.captureStackTrace formats through the same function.
  // every method it calls is taken here: a core that redefines String.prototype.startsWith or includes changes nothing
  const errToString = Error.prototype.toString, sw = String.prototype.startsWith, inc = String.prototype.includes;
  const ownFrame = (f) => typeof f !== 'string' || apply(sw, f, ['core:/']) || apply(sw, f, ['arena:']);
  const head = (e) => { try { return apply(errToString, e, []); } catch { return 'Error'; } };
  const prepare = { prepareStackTrace(e, sites) {
    let s = head(e);
    for (let i = 0; i < sites.length; i++) {
      let f, line;
      try { f = sites[i].getFileName(); line = sites[i].toString(); } catch { break; }
      if (!ownFrame(f) || typeof line !== 'string' || apply(inc, line, ['file:']) || apply(inc, line, ['node:'])) break;
      s += '\\n    at ' + line;
    }
    return s;
  } }.prepareStackTrace;
  Object.defineProperty(Error, 'prepareStackTrace', { value: prepare, writable: false, configurable: false, enumerable: false });
  Object.defineProperty(globalThis, 'Error', { writable: false, configurable: false });
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

// kanban #1813: THIS THREAD'S OWN MEMORY in MB (its isolate: heap, external - the arrays - and malloced), written to the
// control slot FROM_MB (4) as the load and each call begin; the supervisor charges the core only for growth past it
const FROM_MB = 4;
const markFrom = () => { const h = getHeapStatistics(); Atomics.store(ctrl, FROM_MB, Math.round((h.total_heap_size + (h.external_memory || 0) + (h.malloced_memory || 0)) / 1048576)); };
markFrom();

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
  let context, budget;
  for (let tries = 0; ; tries++) {
    v8.setFlagsFromString(V8_EXTENSIONS_OFF);   // kanban #2453: no V8 extension global in the context made next
    context = vm.createContext(vm.constants.DONT_CONTEXTIFY, {
      name: `core ${name}`, codeGeneration: { strings: false, wasm: false }, microtaskMode: 'afterEvaluate',
    });
    try { budget = LOCKDOWN_SCRIPT.runInContext(context); break; } catch (e) {
      // kanban #1489 (merge of #1721 with #1813's concurrent cores): the context was made inside another thread's --expose-gc moment
      if (tries < 8 && /arena:context-again/.test(String(e && e.message))) continue;
      throw e;
    }
  }
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
  markFrom();   // (kanban #1813)
  if (!loaded) return answer({ ok: false, why: 'the core did not load' });
  op = String(op);
  let box;
  try { box = warm || (warm = build()); } catch (e) { return answer({ ok: false, why: `the core failed in ${op}: ${said(e)}` }); }
  let out, why = null;
  try { out = box.run(op, String(json)); } catch (e) { why = `the core failed in ${op}: ${said(e)}`; }
  if (why === null && typeof out !== 'string') why = `the core answered ${op} with something other than JSON`;
  // kanban #1691: an answer longer than ANSWER_MAX is never posted - the context is dropped, and the node ends the core (core-sandbox.js)
  if (why === null && out.length > ANSWER_MAX) { why = `the core failed in ${op}: its answer was longer than ${Math.round(ANSWER_MAX / 1048576)} MB`; if (warm === box) warm = null; return answer({ ok: false, why }); }
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
