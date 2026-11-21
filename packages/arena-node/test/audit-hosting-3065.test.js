// kanban #3065: the card's test
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Audit 2026-11-19 r4, hosting round 3: a gap in #2712's fix (core-depth.js DEPTH_LOCKDOWN isOverflow). An overflow wrapped in a
// SuppressedError is meant to be sticky, but isOverflow follows `error` / `suppressed` / `cause` only 4 levels deep. A core hands
// DisposableStack a BUILTIN as its first disposer (Array.prototype.flat bound to a deeply nested array: no core function on the stack, so
// no LEAVE catch sees the overflow) and six core disposers that throw a plain value after it: dispose() wraps the overflow six
// SuppressedErrors deep. The core's catch hands c() the outer one, isOverflow gives up at depth 5, and the core reads V8's
// "Maximum call stack size exceeded" and branches on it (where the machine's stack ends: arm64/x64, V8 build) - #2220's split.
// Safe behaviour: the core does not load (the overflow is sticky however deep it is wrapped).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { loadCore, coreFiles } from '../src/core-sandbox.js';

const DIR = mkdtempSync(join(tmpdir(), 'audit-hosting-r4-3-1-'));
let n = 0;
const coreOf = (src) => {
  const d = join(DIR, String(n++)); mkdirSync(d, { recursive: true });
  const file = join(d, 'core.js'); writeFileSync(file, src);
  return { name: 'd', hash: createHash('sha256').update(src).digest('hex'), url: pathToFileURL(file).href };
};
const tail = `export const CORE = Object.freeze({ name: 'd', RUN_TICKS: R, INPUT_WORDS: 5, start: () => ({}), eventsOf: () => ({ count: {}, before() {} }),
  step() {}, stateHash: () => 'h', result: () => ({ outcome: 'DELIVERED', score: 0, heat: 0 }) });`;
const nest = `let a = []; for (let i = 0; i < 400000; i++) a = [a];\n`;
const outcome = (src) => {
  try { const box = loadCore(coreFiles(coreOf(src))); const r = box.meta.RUN_TICKS; box.end(); return { loaded: true, r }; }
  catch (e) { return { loaded: false, why: e.message }; }
};
const reader = (wraps) => `${nest}let R = 1;
const s = new DisposableStack();
for (let k = 0; k < ${wraps}; k++) s.defer(() => { throw 5; });
s.defer(a.flat.bind(a, Infinity));
try { s.dispose(); } catch (e) {
  let x = e, levels = 0;
  while (x && typeof x === 'object' && 'suppressed' in x) { x = x.suppressed; levels++; }
  R = x && x.message === 'Maximum call stack size exceeded' ? 700 + levels : 3;
}
${tail}`;

test('control: the overflow wrapped 3 SuppressedErrors deep is sticky (the load fails)', () => {
  const o = outcome(reader(3));
  assert.equal(o.loaded, false, `the control core loaded with RUN_TICKS ${o.r}`);
  assert.match(o.why, /overflowed the stack/);
});

test('the overflow wrapped 6 SuppressedErrors deep is sticky too: the core does not load', () => {
  const o = outcome(reader(6));
  assert.equal(o.loaded, false, `the core read V8's stack overflow through 6 SuppressedErrors and loaded with RUN_TICKS ${o.r} (706 = it read the overflow)`);
});
