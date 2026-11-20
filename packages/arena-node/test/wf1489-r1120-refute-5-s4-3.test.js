// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r1120-refute-5-s4 (honest path of #3085 / #3112): "a static relative import inside the tree allowed" - but scanTree's
// inTree reads an import's statement from its line up to the first line holding a ';'. Honest code written without semicolons (a common
// style) has none on its import line, so the statement runs on into the code below it, the anchored pattern fails, and a plain
// `import { half } from './half.js'` is a finding: the honest tree is refused. Each control (the same tree with semicolons) passes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyPackage } from '../src/plugin-package.js';
import { verifyEd25519 } from '../src/ed25519.js';
import { treePackage } from './wf1489-r1120-refute-5-s3-common.js';

const HELPER = "export const DRAW = 'DRAW'\n";
const NO_SEMI = "import { DRAW } from './lib/draw.js'\n\n"
  + "export const DECIDE = {\n  name: 'nosemi',\n  decide (moves) {\n    const out = {}\n    for (const x of moves) out[x.key] = DRAW\n    return out\n  }\n}\n";
const SEMI = "import { DRAW } from './lib/draw.js';\n\n"
  + "export const DECIDE = {\n  name: 'nosemi',\n  decide (moves) {\n    const out = {};\n    for (const x of moves) out[x.key] = DRAW;\n    return out;\n  }\n};\n";

test('#1489 r1120-refute-5-s4-3: an honest tree written without semicolons passes the tree checks as the same tree with them does', () => {
  const run = (word, adapter) => { const { pkg, gameId } = treePackage(word, [['adapter.js', adapter], ['lib/draw.js', HELPER]]);
    const r = verifyPackage(pkg, { verify: verifyEd25519, want: gameId }); return { ok: r.ok, why: r.why && String(r.why).slice(0, 200) }; };
  const semi = run('tree-semi', SEMI), noSemi = run('tree-nosemi', NO_SEMI);
  console.log('  MEASURED honest trees:', JSON.stringify({ semi, noSemi }));
  assert.equal(semi.ok, true, `control: the tree with semicolons passes (${semi.why})`);
  assert.equal(noSemi.ok, true, `the same honest tree without semicolons is refused: ${noSemi.why}`);
});
