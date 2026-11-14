// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A CORE'S CALL DEPTH, COUNTED BY THE NODE (kanban #2220, #2476; Daniel 2026-11-14: "the depth limit injected into the core at load").
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

const IMPORT = `import{e as ${RESERVED}e,x as ${RESERVED}x,c as ${RESERVED}c}from'${DEPTH_MODULE}';`;
const ENTER = `${RESERVED}e();try{`, LEAVE = `}finally{${RESERVED}x();}`;

/** The core file `text` with its depth counted; throws when it cannot be read or names what the count uses. */
export function instrumentCore(text, rel = 'core') {
  const arrows = [];
  let ast;
  try {
    ast = Parser.parse(text, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true,
      onToken: (t) => { if (t.type.label === '=>') arrows.push(t.end); } });
  } catch (e) { throw new Error(`the core's file ${rel} could not be read: ${String(e && e.message).slice(0, 200)}`); }
  // [position, order, text], applied from the end: at one position the lowest order ends up first - the import, then closes
  // (the deeper node's first), then opens (the outer node's first)
  const edits = [];
  const add = (at, order, s) => edits.push([at, order, s]);
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
        if (node.body.type === 'BlockStatement' && node.body.end - node.body.start === 2) add(node.body.start + 1, OPEN(depth), ENTER + LEAVE);   // {}
        else if (node.body.type === 'BlockStatement') { add(node.body.start + 1, OPEN(depth), ENTER); add(node.body.end - 1, CLOSE(depth), LEAVE); }
        else { add(arrowAt(node), OPEN(depth), `{${ENTER}return (`); add(node.end, CLOSE(depth), `);${LEAVE}}`); }
        break;
      case 'PropertyDefinition':
        // a field's initializer runs as a function of its own (an implicit constructor recursing through `new` is counted here)
        if (node.value) { add(node.value.start, OPEN(depth), `(()=>{${ENTER}return (`); add(node.value.end, CLOSE(depth), `);${LEAVE}})()`); }
        break;
      case 'CatchClause':
        // a caught error asks the count first: past a stack overflow (sticky) it is thrown on
        if (!node.param) add(node.body.start, OPEN(depth), `(${RESERVED}t)`);
        add(node.body.start + 1, OPEN(depth), node.param && node.param.type !== 'Identifier' ? `${RESERVED}c();` : `${RESERVED}c(${node.param ? node.param.name : `${RESERVED}t`});`);
        break;
      case 'TryStatement':
        if (node.finalizer) add(node.finalizer.start + 1, OPEN(depth), `${RESERVED}c();`);
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
  let out = text;
  for (const [at, , s] of edits) out = out.slice(0, at) + s + out.slice(at);
  return out;
}

/** The lockdown's half (core-host.js): the counting functions, made in the core's realm. `RangeErr` is the realm's RangeError,
 *  taken before any core code ran. Answers { e, x, c, begin(), over() }. Inserted as source text into the lockdown script. */
export const DEPTH_LOCKDOWN = `(() => {
    const max = ${DEPTH_MAX}, said = ${JSON.stringify(DEPTH_SAID)}, RE = RangeError, ownDesc = Object.getOwnPropertyDescriptor, isProto = Object.prototype.isPrototypeOf, apply = Reflect.apply, REp = RangeError.prototype;
    let d = 0, sticky = null;
    const e = () => { if (sticky !== null) throw new RE(sticky); if (++d > max) { d--; throw new RE(said); } };
    const x = () => { if (d > 0) d--; };
    const overflow = 'Maximum call stack size exceeded';
    const c = (err) => {
      if (sticky !== null) throw new RE(sticky);
      if (err !== null && typeof err === 'object' && apply(isProto, REp, [err])) {
        const m = ownDesc(err, 'message');
        if (m && m.value === overflow) { sticky = 'the core overflowed the stack'; throw new RE(sticky); }
      }
    };
    return Object.freeze({ e, x, c, begin() { d = 0; }, over: () => sticky });
  })()`;
