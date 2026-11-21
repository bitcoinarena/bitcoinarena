// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3085 (#1489 r1120-refute-5-s2): a game developer (not a relaying seat) hides a dynamic import / require / bare side-effect import
// in a tree file behind one allowed static relative import above it. scanSource reports only the FIRST hit of each rule; scanTree exempts
// that first hit (a static import inside the tree) and never sees the later one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scanTree } from '../src/plugin-check.js';

const enc = (s) => new TextEncoder().encode(s);
const L = 'loads another module';
const helper = { path: 'helper.js', bytes: enc('export const h = 1;\n') };
const cases = {
  'import() after a static tree import': "import { h } from './helper.js';\nexport const DECIDE = async () => (await import('node:fs')).readFileSync;\n",
  'require() after a static tree import': "import { h } from './helper.js';\nexport const DECIDE = () => require('f' + 's');\n",
  'bare side-effect import after a static tree import': "import { h } from './helper.js';\nimport 'node:fs';\nexport const DECIDE = () => h;\n",
};
for (const [name, src] of Object.entries(cases)) {
  test(`#3085: the tree scan still refuses ${name}`, () => {
    const r = scanTree([{ path: 'adapter.js', bytes: enc(src) }, helper]).map((x) => x.rule);
    assert.ok(r.includes(L), `${name}: findings ${JSON.stringify(r)}`);
  });
}
test('control: the same import() alone is found', () => {
  const r = scanTree([{ path: 'adapter.js', bytes: enc("export const DECIDE = async () => (await import('node:fs'));\n") }, helper]).map((x) => x.rule);
  assert.ok(r.includes(L));
});
test('honest: a static import inside the tree alone passes', () => {
  assert.deepEqual(scanTree([{ path: 'adapter.js', bytes: enc("import { h } from './helper.js';\nexport const DECIDE = () => h;\n") }, helper]), []);
});
test('every line checked, still linear: 2 MB of allowed imports, one import() at the end, under 3 s', () => {
  const line = "import { h } from './helper.js';\n", k = Math.floor((2 * 1024 * 1024 - 100) / line.length);
  const t0 = Date.now();
  const r = scanTree([{ path: 'adapter.js', bytes: enc(line.repeat(k) + "export const D = () => import('x');\n") }, helper]);
  assert.ok(Date.now() - t0 < 3000, `${Date.now() - t0} ms`);
  assert.deepEqual(r.filter((x) => x.rule === L).map((x) => x.line), [k + 1]);
});
