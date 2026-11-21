// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r1120-refute-5-s3 (variant of #3100): blankComments does not know a hashbang. A module may start with `#!...`, a comment
// to the end of that line; the lexer reads `#!/*` as the start of a block comment and blanks every line up to a later `*/` (here on a
// `//*/` line, which JS reads as a line comment). Code the one-file scan refuses (globalThis, Reflect) passes the tree scan and the trial.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scanSource } from '../src/plugin-check.js';
import { verifyPackage } from '../src/plugin-package.js';
import { verifyEd25519 } from '../src/ed25519.js';
import { treePackage } from './wf1489-r1120-refute-5-s3-common.js';

const adapter = "#!/*\nconst G = globalThis, R = Reflect;\n//*/\n"
  + "export const DECIDE = { name: 'hb', decide(moves) { const out = {}; for (const x of moves) out[x.key] = typeof G === 'object' && R ? 'DRAW' : 'DRAW'; return out; } };\n";

test('#1489 r1120-refute-5-s3-1: a hashbang `#!/*` hides globalThis / Reflect from the tree scan', () => {
  assert.ok(scanSource(adapter).length >= 2, 'the one-file scan finds globalThis and Reflect');
  const { pkg, gameId } = treePackage('tree-hashbang', [['adapter.js', adapter]]);
  const r = verifyPackage(pkg, { verify: verifyEd25519, want: gameId });
  console.log('  MEASURED hashbang tree:', JSON.stringify({ ok: r.ok, why: r.why, findings: r.findings.length }).slice(0, 300));
  assert.equal(r.ok, false, 'a tree core reaching globalThis and Reflect was verified (scan blanked them as a comment) and ran in the trial');
});
