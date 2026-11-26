// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A BUILT-IN'S RECURSION INTO THE CORE'S DATA, CAPPED AT A FIXED DEPTH (kanban #3540; the owner 2026-11-25: option 2, "cap nesting at a
// fixed depth for the built-in functions that recurse, so every seat refuses the same cores whatever its architecture").
//
// core-depth.js counts the core's own functions, so V8's stack is never reached through them. A built-in that recurses on nested data
// reached it with no core function on the stack: String() of a 100000-deep array loaded on x86_64 (5.0 s) and overflowed on arm64,
// because how many frames fit in CORE_STACK_MB is the machine's frame size. Each built-in below now counts one level per level of the
// data it descends into, on the SAME count as the core's calls (depth.n / depth.x, DEPTH_MAX 10000): the calls and the data's levels
// together stay under DEPTH_MAX, and the level past it throws NEST_SAID (a RangeError, catchable like DEPTH_SAID) before the built-in
// goes deeper. The depth is the data's, never the machine's, so the refusal is the same on every seat and at every speed.
//
// Which built-ins, and how (measured on node 24.22 and 26.12, docs/3540-STACK-ARCH-NOTE.md):
// - Array.prototype.join, Array.prototype.toLocaleString, Error.prototype.toString, RegExp.prototype.toString: each reaches the next
//   level through a property lookup on the element / name / message / source (ToString -> toString -> join ...), so each is wrapped
//   in a function that counts one level around the original. V8's own join cycle check still sees every level (it is the original).
// - JSON.stringify recurses inside V8 with no lookup a wrapper sees, so it runs with a replacer function of the lockdown's that knows
//   each value's level (the holder's + 1) and refuses before V8 descends; the core's own replacer function is called from it as V8
//   would call it, and a property-list replacer is turned into views (a Proxy per object, its keys in the list's order) - V8 still
//   does all of the serializing.
// - JSON.parse with a reviver: V8's internalizing walk recurses (without a reviver V8's parser is iterative and is left as it is).
//   The text's nesting is measured first (brackets outside strings), V8 parses it once with a reviver of the lockdown's that only
//   records each value's source (the reviver's third argument), and the walk itself runs here, counted, calling the core's reviver
//   with the arguments V8 gives - including what the core's reviver puts in places not walked yet.
// - Array.prototype.flat runs here, as ECMA-262 FlattenIntoArray gives it, counting one level per array it descends into.
// The originals are taken here before any core code runs and kept in this closure only; the wrapped methods keep each original's
// name, length and property attributes (writable, configurable), so a core that replaces one gets its own function, never the original.
import { DEPTH_MAX, NEST_SAID } from './core-depth.js';

export { DEPTH_MAX as NEST_MAX, NEST_SAID };

/** The lockdown's half: a function of the core-depth count, run once in the core's realm before any core code. */
export const NEST_LOCKDOWN = `((depth) => {
  'use strict';
  const n = depth.n, x = depth.x, fits = depth.fits, deny = depth.deny, lift = depth.lift, drop = depth.drop;
  const apply = Reflect.apply, construct = Reflect.construct, has = Reflect.has, get = Reflect.get, del = Reflect.deleteProperty, def = Reflect.defineProperty;
  const dp = Object.defineProperty, gd = Object.getOwnPropertyDescriptor, keysOf = Object.keys, is = Object.is, Obj = Object;
  const isArr = Array.isArray, P = Proxy, WM = WeakMap, wmGet = WeakMap.prototype.get, wmSet = WeakMap.prototype.set;
  const Mp = Map, mGet = Map.prototype.get, mSet = Map.prototype.set, mHas = Map.prototype.has;
  const species = Symbol.species, TypeErr = TypeError, trunc = Math.trunc, MAX_LEN = 9007199254740991, cca = String.prototype.charCodeAt;
  const sVal = String.prototype.valueOf, nVal = Number.prototype.valueOf, bVal = Boolean.prototype.valueOf, biVal = BigInt.prototype.valueOf;
  const isRaw = typeof JSON.isRawJSON === 'function' ? JSON.isRawJSON : () => false;
  // every descriptor is a null-prototype object: a 'get' or 'value' a core puts on Object.prototype is never read as part of one
  const data = (v) => ({ __proto__: null, value: v, writable: true, enumerable: true, configurable: true });
  const slot = (f, v) => { try { apply(f, v, []); return true; } catch { return false; } };
  const isObj = (v) => (v !== null && typeof v === 'object') || typeof v === 'function';
  const toLength = (v) => { const k = +v; return k > 0 ? (k === Infinity ? MAX_LEN : trunc(k) < MAX_LEN ? trunc(k) : MAX_LEN) : 0; };
  const toInt = (v) => { const k = +v; return k !== k ? 0 : (k === Infinity || k === -Infinity ? k : trunc(k)); };
  /** o[k] = f, with the original's length and property attributes. */
  const put = (o, k, f) => {
    const d = gd(o, k);
    dp(f, 'length', { __proto__: null, value: d.value.length, writable: false, enumerable: false, configurable: true });
    dp(o, k, { __proto__: null, value: f, writable: d.writable, enumerable: d.enumerable, configurable: d.configurable });
  };

  // ONE LEVEL PER CALL: the built-ins that reach the next level of the data through a property lookup
  const counted = (o, k) => {
    const f = o[k];
    put(o, k, { [k](...a) { n(); try { return apply(f, this, a); } finally { x(); } } }[k]);
  };
  counted(Array.prototype, 'join');
  counted(Array.prototype, 'toLocaleString');
  counted(Error.prototype, 'toString');
  counted(RegExp.prototype, 'toString');

  // JSON.stringify: V8 serializes, a replacer of ours keeps each value's level and refuses the level past the cap
  const stringify0 = JSON.stringify;
  /** ECMA-262 JSON.stringify step 4.b: the property list of an array replacer, read in its order. */
  const propertyList = (rep) => {
    const list = [], seen = new Mp();
    let k = 0;
    const len = toLength(rep.length);
    for (let i = 0; i < len; i++) {
      const v = rep[i];
      let item;
      if (typeof v === 'string') item = v;
      else if (typeof v === 'number') item = '' + v;
      else if (v !== null && typeof v === 'object' && (slot(sVal, v) || slot(nVal, v))) item = \`\${v}\`;
      if (item !== undefined && !apply(mHas, seen, [item])) { apply(mSet, seen, [item, true]); dp(list, k++, data(item)); }
    }
    return list;
  };
  /** A value V8 does not descend into as an object, whatever its level (unwrapped, raw JSON). */
  const leaf = (v) => slot(nVal, v) || slot(sVal, v) || slot(bVal, v) || slot(biVal, v) || isRaw(v);
  const viewHandler = (v, list) => ({ __proto__: null,
    ownKeys: () => list,
    getOwnPropertyDescriptor: () => data(undefined),
    get: (t, k) => get(v, k) });
  put(JSON, 'stringify', { stringify(value, replacer, space) {
    let fn = null, list = null;
    if (typeof replacer === 'function') fn = replacer;
    else if (isArr(replacer)) list = propertyList(replacer);
    const level = new WM(), views = list === null ? null : new WM();
    let root = null;
    const hook = function (k, v) {
      let L = 0;
      if (root === null) root = this; else { const l = apply(wmGet, level, [this]); if (l !== undefined) L = l; }
      if (fn !== null) {
        // the level past the cap is refused before the core's replacer runs on it (it would run one call past the count)
        if (v !== null && typeof v === 'object' && !fits(L + 1) && !leaf(v)) deny();
        lift(L);
        try { v = apply(fn, this, [k, v]); } finally { drop(L); }
      }
      if (v !== null && typeof v === 'object') {
        if (!fits(L + 1) && !leaf(v)) deny();
        if (views !== null && !isArr(v) && !leaf(v)) {
          let w = apply(wmGet, views, [v]);
          if (w === undefined) { w = new P({}, viewHandler(v, list)); apply(wmSet, views, [v, w]); }
          v = w;
        }
        apply(wmSet, level, [v, L + 1]);
      }
      return v;
    };
    return apply(stringify0, JSON, [value, hook, space]);
  } }.stringify);

  // JSON.parse with a reviver: the text's depth first, V8's parse once (recording each value's source), the walk counted here
  const parse0 = JSON.parse;
  const textDepth = (s) => {
    let d = 0, top = 0;
    for (let i = 0, L = s.length; i < L; i++) {
      const c = apply(cca, s, [i]);
      if (c === 34) { for (i++; i < L; i++) { const e = apply(cca, s, [i]); if (e === 92) i++; else if (e === 34) break; } }
      else if (c === 91 || c === 123) { if (++d > top) top = d; }
      else if (c === 93 || c === 125) d--;
    }
    return top;
  };
  // ECMA-262 InternalizeJSONProperty, with V8's third argument: { source } for a primitive still the one parsed at its place
  const walk = (holder, name, snap, reviver, recs) => {
    const val = get(holder, name);
    const pristine = snap !== undefined && is(val, snap.v);
    if (isObj(val)) {
      n();
      try {
        const kids = pristine ? apply(wmGet, recs, [val]) : undefined;
        const one = (p) => {
          const ne = walk(val, p, kids !== undefined ? apply(mGet, kids, [p]) : undefined, reviver, recs);
          if (ne === undefined) del(val, p); else def(val, p, data(ne));
        };
        if (isArr(val)) { const len = toLength(get(val, 'length')); for (let i = 0; i < len; i++) one('' + i); }
        else { const ks = keysOf(val); for (let i = 0; i < ks.length; i++) one(ks[i]); }
      } finally { x(); }
    }
    const ctx = {};
    if (pristine && !isObj(snap.v) && snap.src !== undefined) dp(ctx, 'source', data(snap.src));
    return apply(reviver, holder, [name, val, ctx]);
  };
  put(JSON, 'parse', { parse(text, reviver) {
    if (typeof reviver !== 'function') return apply(parse0, JSON, [text, reviver]);
    const s = \`\${text}\`;
    if (!fits(textDepth(s))) { apply(parse0, JSON, [s]); deny(); }   // a text that is no JSON is still V8's SyntaxError
    const recs = new WM();
    let last;
    const rec = function (k, v, ctx) {
      let m = apply(wmGet, recs, [this]);
      if (m === undefined) { m = new Mp(); apply(wmSet, recs, [this, m]); }
      const d = isObj(ctx) ? gd(ctx, 'source') : undefined;
      last = { __proto__: null, v, src: d !== undefined ? d.value : undefined };
      apply(mSet, m, [k, last]);
      return v;
    };
    const result = apply(parse0, JSON, [s, rec]);
    const top = {};
    dp(top, '', data(result));
    return walk(top, '', last, reviver, recs);
  } }.parse);

  // Array.prototype.flat: ECMA-262 FlattenIntoArray, one level counted per array it descends into
  const probe = { __proto__: null, construct: () => ({}) };
  const isCtor = (f) => { if (!isObj(f)) return false; try { construct(new P(f, probe), []); return true; } catch { return false; } };
  // ArraySpeciesCreate(O, 0) - the core's realm is the only one a core can reach, so its step 3 (another realm's Array) never applies
  const speciesCreate = (O) => {
    if (!isArr(O)) return [];
    let C = O.constructor;
    if (isObj(C)) { C = C[species]; if (C === null) C = undefined; }
    if (C === undefined) return [];
    if (!isCtor(C)) throw new TypeErr('object.constructor[Symbol.species] is not a constructor');
    return construct(C, [0]);
  };
  const flatten = (target, source, sourceLen, start, d) => {
    n();
    try {
      let t = start;
      for (let i = 0; i < sourceLen; i++) {
        if (!has(source, i)) continue;
        const el = get(source, i);
        if (d > 0 && isArr(el)) t = flatten(target, el, toLength(get(el, 'length')), t, d === Infinity ? d : d - 1);
        else {
          if (t >= MAX_LEN) throw new TypeErr('Array.prototype.flat: the result would be longer than 2^53 - 1');
          dp(target, '' + t, data(el));
          t++;
        }
      }
      return t;
    } finally { x(); }
  };
  put(Array.prototype, 'flat', { flat(depthArg) {
    if (this === null || this === undefined) throw new TypeErr('Cannot convert undefined or null to object');
    const O = Obj(this);
    const len = toLength(O.length);
    let dn = 1;
    if (depthArg !== undefined) { dn = toInt(depthArg); if (dn < 0) dn = 0; }
    const A = speciesCreate(O);
    flatten(A, O, len, 0, dn);
    return A;
  } }.flat);
})`;
