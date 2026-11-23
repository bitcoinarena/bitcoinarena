// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3135, #3136, #1489 r1120-refute-5-s4: the honest side of the fixes - every frozen Next Block tree stays far below the lexer budget
// and passes the tree scan; trees whose directories are spelled one way, and names Windows keeps, pass treeFilesOf; the variants are refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blankComments, scanTree, treeFilesOf, LEX_EXTRA_MOST, LEX_TREE_EXTRA_MOST } from '../src/plugin-check.js';

const FROZEN = join(dirname(fileURLToPath(import.meta.url)), '../../nextblock/frozen');
const b64 = (t) => Buffer.from(t).toString('base64');
const tree = (paths) => treeFilesOf({ entry: 'adapter.js', files: ['adapter.js', ...paths].map((path) => ({ path, body: b64('export const A = 1;\n') })) });

test('#3135: every frozen Next Block tree uses under 1 % of the lexer budget and scans clean', { skip: !existsSync(FROZEN) }, () => {
  for (const h of readdirSync(FROZEN)) {
    const root = join(FROZEN, h), files = [];
    const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.js')) files.push({ path: relative(root, p), bytes: new Uint8Array(readFileSync(p)) }); } };
    walk(root);
    const budget = { left: LEX_TREE_EXTRA_MOST };
    for (const f of files) blankComments(new TextDecoder().decode(f.bytes), budget);
    const used = LEX_TREE_EXTRA_MOST - budget.left;
    console.log('  MEASURED', h.slice(0, 8), files.length, 'files, extra reading-steps', used);
    assert.ok(used < LEX_EXTRA_MOST / 100, `${h}: ${used} extra reading-steps`);
    assert.deepEqual(scanTree(files), [], h);
  }
});

test('#3136: one spelling per directory, names Windows keeps', () => {
  assert.equal(tree(['lib/a.js', 'lib/b.js', 'lib/x/c.js']).ok, true);
  assert.equal(tree(['lib/a.js', 'LIB/b.js']).ok, false);
  assert.equal(tree(['a/Lib/x.js', 'a/lib/y.js']).ok, false);
  assert.equal(tree(['Lib/x/a.js', 'Lib/X/b.js']).ok, false);
  assert.equal(tree(['a./x.js']).ok, false);
  assert.equal(tree(['con.js']).ok, false);
  assert.equal(tree(['lib/aux/x.js']).ok, false);
  assert.equal(tree(['console.js', 'lib/com.js', 'auxiliary/x.js']).ok, true);
});
