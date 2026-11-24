// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3558 (RCE audit #3552, low): A CORE'S BIGINT IS BOUNDED BEFORE THE NODE PARSES IT. core-sandbox.js revive turned every
// {"$big": <digits>} of a core's answer into a BigInt in the seat's own thread with no length cap: 4 MB of digits cost the seat about
// 1 s per decide (854 ms measured), and decide is not cached. And a core whose top level awaits a promise that never settles was
// taken as loaded (its module status said 'evaluated') and failed only later, on its first call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCore, BIG_DIGITS_MAX } from '../src/core-sandbox.js';

const load = (src, o = {}) => loadCore({ files: new Map([['core.mjs', src]]), entry: 'core.mjs' }, o);

test('#3558: a decide answering a $big of 4 MB of digits is refused, not parsed in the seat thread', () => {
  const box = load(`export const DECIDE = { name: 'big', decide(moves) { return { a: { outcome: 'WIN', score: { $big: '9'.repeat(4000000) } } }; } };`);
  try {
    const t0 = performance.now();
    assert.throws(() => box.call('decide', { moves: [], config: {} }), /\$big|digits/);
    const ms = performance.now() - t0;
    console.log(`#3558 a 4 MB $big answer refused in ${ms.toFixed(0)} ms`);
  } finally { box.end(); }
});

test('#3558: a $big at the bound is read back as a BigInt, one past it is refused', () => {
  const box = load(`export const DECIDE = { name: 'big', decide(moves) { return moves[0] === 1 ? { $big: '7'.repeat(${BIG_DIGITS_MAX}) } : { $big: '-' + '7'.repeat(${BIG_DIGITS_MAX} + 1) }; } };`);
  try {
    assert.equal(box.call('decide', { moves: [1], config: {} }), BigInt('7'.repeat(BIG_DIGITS_MAX)));
    assert.throws(() => box.call('decide', { moves: [2], config: {} }), /\$big|digits/);
    // an honest 64-bit amount and a negative one pass as before
    const ok = load(`export const DECIDE = { name: 'ok', decide() { return [18446744073709551615n, -5n]; } };`);
    try { assert.deepEqual(ok.call('decide', { moves: [], config: {} }), [18446744073709551615n, -5n]); } finally { ok.end(); }
  } finally { box.end(); }
});

test('#3558: a core whose top level awaits a promise that never settles is refused at load', () => {
  assert.throws(() => load(`await new Promise(() => {}); export const CORE = { name: 'tla' };`),
    /did not finish loading/);
  // a top-level await that settles at once still loads
  const fine = load(`await null; export const DECIDE = { name: 'tla-ok', decide() { return 1; } };`);
  try { assert.equal(fine.call('decide', { moves: [], config: {} }), 1); } finally { fine.end(); }
});
