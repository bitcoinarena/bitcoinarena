// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2220, #2476: the depth limit injected into a core at load (core-depth.js). The count cannot be reached by the core:
// a core naming the sandbox's __arena$ names, or importing 'arena:depth' itself, is refused; a core that recurses past DEPTH_MAX
// reads the same depth on every load; recursion within it answers as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { loadCore, coreFiles } from '../src/core-sandbox.js';
import { DEPTH_MAX } from '../src/core-depth.js';

const DIR = mkdtempSync(join(tmpdir(), 'core-depth-2220-'));
let n = 0;
const coreOf = (src) => {
  const d = join(DIR, String(n++)); mkdirSync(d, { recursive: true });
  const file = join(d, 'core.js'); writeFileSync(file, src);
  return { name: 'd', hash: createHash('sha256').update(src).digest('hex'), url: pathToFileURL(file).href };
};
const tail = `export const CORE = Object.freeze({ name: 'd', RUN_TICKS: R, INPUT_WORDS: 5, start: () => ({}), eventsOf: () => ({ count: {}, before() {} }),
  step() {}, stateHash: () => 'h', result: () => ({ outcome: 'DELIVERED', score: 0, heat: 0 }) });`;

test('a core cannot name or import the count', () => {
  assert.throws(() => loadCore(coreFiles(coreOf(`const R = 1; try { __arena$x(); } catch {}\n${tail}`))), /__arena\$ names are the sandbox's/);
  assert.throws(() => loadCore(coreFiles(coreOf(`const R = 1; const \\u005f_arena$x = 1;\n${tail}`))), /__arena\$ names are the sandbox's/);
  assert.throws(() => loadCore(coreFiles(coreOf(`import { x } from 'arena:depth'; const R = 1;\n${tail}`))), /may import only its own files/);
});

test('a core reads one depth past the limit, and recursion within it answers as before', () => {
  const deep = `let d = 0; const f = () => { d++; f(); }; try { f(); } catch (e) { if (!/nested its calls/.test(e.message)) throw e; } const R = d;\n${tail}`;
  const seen = new Set();
  for (let i = 0; i < 4; i++) { const box = loadCore(coreFiles(coreOf(deep))); seen.add(box.meta.RUN_TICKS); box.end(); }
  assert.deepEqual([...seen], [DEPTH_MAX]);
  const ok = `const f = (k) => (k > 0 ? 1 + f(k - 1) : 0); const R = f(${DEPTH_MAX - 10});\n${tail}`;
  const box = loadCore(coreFiles(coreOf(ok)));
  assert.equal(box.meta.RUN_TICKS, DEPTH_MAX - 10);
  box.end();
});
