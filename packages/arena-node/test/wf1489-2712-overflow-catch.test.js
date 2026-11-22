// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 round 4 (hosting): a bypass of #2220 / #2476 (core-depth.js). Where V8's own stack overflow is still reached
// (a builtin's recursion, a huge frame) the overflow is meant to be STICKY: "every catch and finally the core wrote first asks
// __arena$c, which throws on again, and core-host.js fails the call - the core cannot read where it happened". But __arena$c is
// handed the caught value only when the catch binds a plain identifier: `catch ({ message })` (a destructuring parameter) is
// instrumented as `__arena$c()` - no argument - and c(undefined) passes. And c looks only at the value itself: a stack overflow
// wrapped in a SuppressedError (DisposableStack, a global the sandbox keeps) is caught as a SuppressedError and passes too. Either
// way a hostile core catches V8's overflow, reads at which nesting it happened and branches on it - the per-seat, per-tier
// number #2220 measured splitting committees (11-37 different stateHashes over 40 fresh threads).
// Safe behaviour: a core that catches V8's stack overflow in any form does not load / its call fails ("overflowed the stack").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { loadCore, coreFiles } from '../src/core-sandbox.js';

const DIR = mkdtempSync(join(tmpdir(), 'wf1489-r4-hosting-5-'));
let n = 0;
const coreOf = (src) => {
  const d = join(DIR, String(n++)); mkdirSync(d, { recursive: true });
  const file = join(d, 'core.js'); writeFileSync(file, src);
  return { name: 'd', hash: createHash('sha256').update(src).digest('hex'), url: pathToFileURL(file).href };
};
const tail = `export const CORE = Object.freeze({ name: 'd', RUN_TICKS: R, INPUT_WORDS: 5, start: () => ({}), eventsOf: () => ({ count: {}, before() {} }),
  step() {}, stateHash: () => 'h', result: () => ({ outcome: 'DELIVERED', score: 0, heat: 0 }) });`;
// a builtin's own recursion (JSON.stringify of a deeply nested array) runs out of V8's stack - no core function is entered
const nest = `let a = []; for (let i = 0; i < 1500000; i++) a = [a];\nconst blow = () => JSON.stringify(a);\n`;

const outcome = (src) => {
  try { const box = loadCore(coreFiles(coreOf(src))); const r = box.meta.RUN_TICKS; box.end(); return { loaded: true, r }; }
  catch (e) { return { loaded: false, why: e.message }; }
};

test('control: an identifier catch of V8\'s overflow is sticky (the load fails)', () => {
  const o = outcome(`${nest}let R = 1; try { blow(); } catch (e) { R = e && e.message === 'Maximum call stack size exceeded' ? 777 : 2; }\n${tail}`);
  assert.equal(o.loaded, false, `the control core loaded with RUN_TICKS ${o.r}`);
  assert.match(o.why, /overflowed the stack/);
});

test('a destructuring catch of V8\'s overflow is sticky too', () => {
  const o = outcome(`${nest}let R = 1; try { blow(); } catch ({ message }) { R = message === 'Maximum call stack size exceeded' ? 777 : 2; }\n${tail}`);
  assert.equal(o.loaded, false, `the core caught V8's stack overflow and loaded with RUN_TICKS ${o.r} (777 = it read the overflow)`);
});

test('an overflow wrapped in a SuppressedError is sticky too', () => {
  const src = `${nest}let R = 1;
const s = new DisposableStack();
s.defer(() => { blow(); });
s.defer(() => { throw 5; });
try { s.dispose(); } catch (e) { R = e && e.error && e.error.message === 'Maximum call stack size exceeded' ? 777 : (e && e.suppressed && e.suppressed.message === 'Maximum call stack size exceeded' ? 778 : 3); }
${tail}`;
  const o = outcome(src);
  assert.equal(o.loaded, false, `the core caught V8's stack overflow inside a SuppressedError and loaded with RUN_TICKS ${o.r} (777/778 = it read the overflow)`);
});

test('a finally that returns swallows V8\'s overflow, and that is sticky too', () => {
  const o = outcome(`${nest}const probe = () => { let ok = false; try { blow(); ok = true; } finally { return ok ? 1 : 779; } };\nconst R = probe();\n${tail}`);
  assert.equal(o.loaded, false, `the core swallowed V8's stack overflow in a finally and loaded with RUN_TICKS ${o.r} (779 = it read the overflow)`);
});
