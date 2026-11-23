// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A CORE'S CALL DEPTH, COUNTED BY THE NODE (kanban #2220, #2476; the owner 2026-11-14: "the depth limit injected into the core at load").
//
// A core that recursed until V8's stack overflowed and caught the RangeError read a depth that moved with V8's tier-up: TurboFan
// compiles on a background thread, so whether a frame was interpreted or optimized when the stack ran out depended on timing.
// Measured: 40 fresh-thread replays of one input gave 11-37 different stateHashes; a core's meta read on the kept thread answered
// a run length of 90 and 91, and decide installed and not, over 16 loads. A fresh thread could not fix that - the core makes its
// own warm-up inside one call.
//
// So the overflow is never reached. core-host.js hands every core file through instrumentCore() before it is compiled: every
// function body the core wrote (declarations, expressions, arrows, methods, getters, setters, class field initializers) counts
// one level on entry and gives it back on exit, and the level past DEPTH_MAX throws a RangeError at once - the same depth on
// every seat, every load and every tier, so a core that catches it reads the same number everywhere. DEPTH_MAX sits far below
// what the core thread's stack holds (CORE_STACK_MB), so V8's own overflow is not reached through the core's functions. Where it
// still is (a builtin's own recursion, a huge frame), it is made STICKY: every catch and finally the core wrote first asks
// __arena$c, which throws on again, and core-host.js fails the call - the core cannot read where it happened.
//
// The counting functions come from a module of the sandbox's own ('arena:depth', made in the core's realm by the lockdown) bound
// under names a core may not write (__arena$...): a core that names one, or imports 'arena:depth' itself, is refused - with no
// eval and no Function in the sandbox it cannot reach them any other way.
import { Parser } from './vendor/acorn.mjs';

/** The deepest a core's own functions may nest, counted per call. */
export const DEPTH_MAX = 10000;
/** The core thread's stack: room for DEPTH_MAX frames of about 3 kB each, far above what an honest core's frame takes. */
export const CORE_STACK_MB = 32;
export const DEPTH_SAID = `the core nested its calls more than ${DEPTH_MAX} deep`;
export const DEPTH_MODULE = 'arena:depth';
const RESERVED = '__arena$';
// A CORE'S SIZE, BOUNDED BEFORE IT IS INSTRUMENTED OR COMPILED (kanban #3052, #3067): instrumentCore ran in the seat's own thread on a
// core as large as a peer's package carries (16 MB, 1.8M `()=>0`: 4.6 s frozen, a 200 MB string), and a core with that many functions
// can run its thread out of heap while V8 compiles it - inside CompileModule, where the worker's resourceLimits abort the whole
// process. The shipped cores are about 440 kB and 280 functions; a core's files together may hold CORE_SOURCE_MAX bytes and
// CORE_FUNCTIONS_MAX functions (both checked here, the functions counted while the file is parsed, so the parse stops at the bound).
// WHAT IS COMPILED IS COUNTED, NOT ONLY WHAT THE CORE WROTE (kanban #3386, gap in #3067): every default value and every class field
// initializer is wrapped below in an arrow of its own, which V8 compiles like any other function, and none of them was counted: a
// 1.37 MB core of 350,000 `x=0` destructuring defaults and one real function became 40 MB of source and 350,000 functions, and its
// compile aborted the whole process again (worker.terminate() during the compile does not stop that). Each wrapper now costs one
// function. The parse stops at CORE_TOKENS_MAX tokens (shipped cores: ~52,600; a full parse of 2 MB of `x=0,` held the seat's thread
// 1.2 s and 334 MB before the walk could refuse it), and the instrumented text may hold CORE_INSTRUMENTED_MAX bytes (shipped: ~470 kB),
// checked before it is joined: what reaches the compile is bounded by its own size, not by what the wrappers add.
export const CORE_SOURCE_MAX = 2 * 1024 * 1024;
export const CORE_FUNCTIONS_MAX = 20000;
export const CORE_TOKENS_MAX = 250000;
export const CORE_INSTRUMENTED_MAX = 8 * 1024 * 1024;
/** A fresh budget for one core's files (loadCore makes one per core). */
export const coreBudget = () => ({ bytes: CORE_SOURCE_MAX, functions: CORE_FUNCTIONS_MAX, tokens: CORE_TOKENS_MAX, out: CORE_INSTRUMENTED_MAX });

const IMPORT = `import{e as ${RESERVED}e,x as ${RESERVED}x,c as ${RESERVED}c}from'${DEPTH_MODULE}';`;
// kanban #2731 (#1489 r5-hosting-4): what leaves a core function by a throw asks the count too - an overflow raised in a builtin the
// function called (String() of a deep array) and taken by a promise's rejection handler passed no catch clause and was never made sticky;
// it now turns sticky as it leaves the first function of the core's it passes through, before any handler can read it
const ENTER = `${RESERVED}e();try{`, LEAVE = `}catch(${RESERVED}u){${RESERVED}c(${RESERVED}u);throw ${RESERVED}u;}finally{${RESERVED}x();}`;

/** The core file `text` with its depth counted; throws when it cannot be read or names what the count uses. */
export function instrumentCore(text, rel = 'core', budget = coreBudget()) {
  const arrows = [];
  const tooBig = () => new Error(`the core is too large: its files may hold ${CORE_SOURCE_MAX} bytes, ${CORE_TOKENS_MAX} tokens and ${CORE_FUNCTIONS_MAX} functions `
    + `together (a default value or a class field counts as a function), and ${CORE_INSTRUMENTED_MAX} bytes once instrumented`);
  budget.bytes -= text.length;
  if (budget.bytes < 0) throw tooBig();
  // the parse stops once the arrows and `function`s it has seen (never more than the file's functions) pass what is left, or its tokens
  // do; the walk below then takes every function (methods, getters and setters too) and every wrapper it adds off the budget
  let seen = 0, over = false;
  let ast;
  try {
    ast = Parser.parse(text, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true,
      onToken: (t) => {
        if (t.type.label === '=>') arrows.push(t.end);
        if (--budget.tokens < 0 || ((t.type.label === '=>' || t.type.label === 'function') && ++seen > budget.functions)) { over = true; throw tooBig(); }
      } });
  } catch (e) {
    if (over) throw tooBig();
    throw new Error(`the core's file ${rel} could not be read: ${String(e && e.message).slice(0, 200)}`);
  }
  // [position, order, text], applied from the end: at one position the lowest order ends up first - the import, then closes
  // (the deeper node's first), then opens (the outer node's first)
  const edits = [];
  // kanban #3386: the instrumented text - the file and every insertion - is charged as it is planned, before any of it is joined
  budget.out -= text.length;
  if (budget.out < 0) throw tooBig();
  const add = (at, order, s) => { budget.out -= s.length; if (budget.out < 0) throw tooBig(); edits.push([at, order, s]); };
  const OPEN = (depth) => depth, CLOSE = (depth) => -1e9 - depth;
  const arrowAt = (node) => {
    // the `=>` of this arrow: the last one before its body (one inside a parameter's default value comes before it)
    let lo = 0, hi = arrows.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (arrows[mid] <= node.body.start) lo = mid + 1; else hi = mid; }
    const at = arrows[lo - 1];
    if (!(at > node.start)) throw new Error(`the core's file ${rel} could not be read: an arrow without its =>`);
    return at;
  };
  const walk = (node, depth) => {
    if (!node || typeof node.type !== 'string') return;
    switch (node.type) {
      case 'Identifier': case 'PrivateIdentifier':
        if (node.name.startsWith(RESERVED)) throw new Error(`the core's file ${rel} names ${node.name}, and ${RESERVED} names are the sandbox's`);
        break;
      case 'ImportDeclaration': case 'ExportNamedDeclaration': case 'ExportAllDeclaration':
        // the sandbox's own module is never the core's to import (every other specifier is the gate's in core-host.js)
        if (node.source && String(node.source.value) === DEPTH_MODULE) throw new Error(`the core imports "${node.source.value}", and a core may import only its own files`);
        break;
      case 'FunctionDeclaration': case 'FunctionExpression': case 'ArrowFunctionExpression':
        if (--budget.functions < 0) throw tooBig();
        if (node.body.type === 'BlockStatement' && node.body.end - node.body.start === 2) add(node.body.start + 1, OPEN(depth), ENTER + LEAVE);   // {}
        else if (node.body.type === 'BlockStatement') { add(node.body.start + 1, OPEN(depth), ENTER); add(node.body.end - 1, CLOSE(depth), LEAVE); }
        else { add(arrowAt(node), OPEN(depth), `{${ENTER}return (`); add(node.end, CLOSE(depth), `);${LEAVE}}`); }
        break;
      case 'PropertyDefinition':
        // a field's initializer runs as a function of its own (an implicit constructor recursing through `new` is counted here)
        // kanban #3386: that wrapper is a function V8 compiles, so it costs one
        if (node.value) {
          if (--budget.functions < 0) throw tooBig();
          add(node.value.start, OPEN(depth), `(()=>{${ENTER}return (`); add(node.value.end, CLOSE(depth), `);${LEAVE}})()`);
        }
        break;
      case 'AssignmentPattern':
        // A DEFAULT VALUE RUNS BEFORE THE BODY'S COUNT (kanban #2837, #1489 r24-hosting-1): function f(k, d = k > 0 ? 1 + f(k - 1) : 0) nested
        // through its parameter defaults uncounted, past DEPTH_MAX into V8's own overflow, whose depth moves with tier-up. Every default value
        // (a parameter's, a destructuring pattern's) is now counted as a function of its own, as a class field's initializer is - an arrow, so
        // `this` and `arguments` read as before. kanban #3386: that arrow is compiled like any other function, so it costs one
        if (node.right) {
          if (--budget.functions < 0) throw tooBig();
          add(node.right.start, OPEN(depth), `(()=>{${ENTER}return (`); add(node.right.end, CLOSE(depth), `);${LEAVE}})()`);
        }
        break;
      case 'CatchClause':
        // a caught error asks the count first: past a stack overflow (sticky) it is thrown on
        if (!node.param) add(node.body.start, OPEN(depth), `(${RESERVED}t)`);
        add(node.body.start + 1, OPEN(depth), node.param && node.param.type !== 'Identifier' ? `${RESERVED}c();` : `${RESERVED}c(${node.param ? node.param.name : `${RESERVED}t`});`);
        break;
      case 'TryStatement':
        if (node.finalizer) add(node.finalizer.start + 1, OPEN(depth), `${RESERVED}c();`);
        // A TRY WHOSE CATCH CANNOT HAND C THE CAUGHT VALUE (kanban #2712, audit #1489 r4-hosting-5, high): `catch ({ message })` (a destructuring
        // parameter) and a `finally` with no catch (whose return, break or throw swallows what was thrown) let V8's own overflow pass c unseen,
        // and the core read where it happened. Its block is wrapped - inserted text only - in a try whose catch asks c with the value and throws
        // it on: an overflow is sticky before the core's own catch or finally runs, and anything else goes on exactly as before.
        if (!node.handler || (node.handler.param && node.handler.param.type !== 'Identifier')) {
          add(node.block.start, OPEN(depth), '{try');
          add(node.block.end, CLOSE(depth), `catch(${RESERVED}w){${RESERVED}c(${RESERVED}w);throw ${RESERVED}w;}}`);
        }
        break;
      default: break;
    }
    for (const k of Object.keys(node)) {
      if (k === 'type' || k === 'start' || k === 'end') continue;
      const v = node[k];
      if (Array.isArray(v)) { for (const c of v) walk(c, depth + 1); } else if (v && typeof v === 'object' && typeof v.type === 'string') walk(v, depth + 1);
    }
  };
  walk(ast, 0);
  // a hashbang line stays the first; the import goes on the first line of code, so the core's line numbers do not move
  if (!text.startsWith('#!')) add(0, -Infinity, IMPORT);
  else if (text.indexOf('\n') >= 0) add(text.indexOf('\n') + 1, -Infinity, IMPORT);
  else add(text.length, -Infinity, '\n' + IMPORT);
  edits.sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  // ONE PASS, LINEAR (kanban #2675, audit #1489 r2-hosting-13, high): each edit was applied as out.slice(0, at) + s + out.slice(at),
  // copying the whole growing text per edit - O(N x length) in the seat's own thread before any trial deadline (30k tiny functions,
  // 180 kB: 4.5 s frozen; a 16 MB package: minutes). The same edits in the same order, gathered back to front and joined once:
  // byte for byte the text the old loop made (an edit at the same place as an earlier one still lands before it)
  const parts = [];
  let upTo = text.length;
  for (const [at, , s] of edits) { parts.push(text.slice(at, upTo), s); upTo = at; }
  parts.push(text.slice(0, upTo));
  return parts.reverse().join('');
}

/** The lockdown's half (core-host.js): the counting functions, made in the core's realm. `RangeErr` is the realm's RangeError,
 *  taken before any core code ran. Answers { e, x, c, begin(), over() }. Inserted as source text into the lockdown script. */
export const DEPTH_LOCKDOWN = `(() => {
    const max = ${DEPTH_MAX}, said = ${JSON.stringify(DEPTH_SAID)}, RE = RangeError, isArr = Array.isArray, ownDesc = Object.getOwnPropertyDescriptor, isProto = Object.prototype.isPrototypeOf, apply = Reflect.apply, REp = RangeError.prototype;
    let d = 0, sticky = null;
    const e = () => { if (sticky !== null) throw new RE(sticky); if (++d > max) { d--; throw new RE(said); } };
    const x = () => { if (d > 0) d--; };
    const overflow = 'Maximum call stack size exceeded';
    // kanban #2712: an overflow WRAPPED (a SuppressedError's error / suppressed, an AggregateError's errors, a cause) is the overflow too -
    // own data properties only, a few levels deep, so no getter of the core's runs here
    // kanban #3065 (audit hosting r4-3-1, gap in #2712): the walk stopped 4 levels down and read 16 of an AggregateError's errors, so an overflow
    // a DisposableStack wrapped in 6 SuppressedErrors was not sticky. It now walks every wrapped value (own data properties only) with no fixed
    // depth, each object once; a wrapping too large to walk (more than WALK_MOST objects) counts as the overflow - the same answer on every
    // machine. Only what was taken before any core code ran is used (no array or WeakSet method the core could replace)
    const WALK_MOST = 4096, WS = WeakSet, wsAdd = WeakSet.prototype.add, wsHas = WeakSet.prototype.has, KEYS = ['error', 'suppressed', 'cause'];
    const isOverflow = (err0) => {
      if (err0 === null || typeof err0 !== 'object') return false;
      const todo = { __proto__: null, 0: err0 }, seen = new WS();   // a null-prototype stack: no setter a core put on Array.prototype is hit
      let top = 1, n = 0;
      while (top > 0) {
        const err = todo[--top];
        if (err === null || typeof err !== 'object' || apply(wsHas, seen, [err])) continue;
        apply(wsAdd, seen, [err]);
        if (++n > WALK_MOST) return true;
        if (apply(isProto, REp, [err])) { const m = ownDesc(err, 'message'); if (m && m.value === overflow) return true; }
        for (let j = 0; j < 3; j++) { const v = ownDesc(err, KEYS[j]); if (v && 'value' in v) { if (top >= WALK_MOST) return true; todo[top++] = v.value; } }
        const es = ownDesc(err, 'errors');
        if (es && 'value' in es && isArr(es.value)) {
          const len = ownDesc(es.value, 'length'), L = len && typeof len.value === 'number' ? len.value : 0;
          if (L > WALK_MOST) return true;
          for (let i = 0; i < L; i++) { const v = ownDesc(es.value, String(i)); if (v && 'value' in v) { if (top >= WALK_MOST) return true; todo[top++] = v.value; } }
        }
      }
      return false;
    };
    const c = (err) => {
      if (sticky !== null) throw new RE(sticky);
      if (isOverflow(err)) { sticky = 'the core overflowed the stack'; throw new RE(sticky); }
    };
    return Object.freeze({ e, x, c, begin() { d = 0; }, over: () => sticky });
  })()`;
