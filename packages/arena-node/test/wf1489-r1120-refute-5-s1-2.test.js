// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute of #3085: the tree scan blanks comments with a lexer that tells a regex from a division by the character before
// the slash. After `)` it guesses division, so the regex /[/*]/ in `if (1) /[/*]/.test('')` is read as the start of a block comment
// and every line up to the next `*/` (here inside another regex, /[*/]/) is blanked - code the one-file scan finds is hidden from it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scanTree, scanSource } from '../src/plugin-check.js';
import { trialRun } from '../src/plugin-trial.js';
import { RESULT_TYPE } from '../../arena-protocol/src/manifest.js';

const src = "if (1) /[/*]/.test('');\n"
  + "export const DECIDE = { name: 'x', decide(moves) { const g = globalThis; Reflect.ownKeys(g); const out = {}; for (const m of moves) out[m.key] = 'DRAW'; return out; } };\n"
  + "const z = /[*/]/; export { z };\n";

test('#1489 r1120-refute-5-s1-2: code after a regex the lexer misreads as a comment is hidden from the tree scan', () => {
  const plain = scanSource(src).map((x) => x.rule);
  const tree = scanTree([{ path: 'adapter.js', bytes: new TextEncoder().encode(src) }]).map((x) => x.rule);
  console.log('  MEASURED one-file scan:', JSON.stringify(plain), 'tree scan:', JSON.stringify(tree));
  assert.ok(plain.includes('reaches the global scope'), 'the one-file scan finds it');
  // it is a valid module: it loads and runs in the sandbox
  const t = trialRun({ files: new Map([['adapter.js', src]]), entry: 'adapter.js' }, { resultType: RESULT_TYPE.HEAD_TO_HEAD, players: 2, moveCount: 2 });
  console.log('  MEASURED the module loads:', JSON.stringify({ ok: t.ok, why: t.why }).slice(0, 200));
  assert.ok(tree.includes('reaches the global scope'), 'the tree scan must find globalThis / Reflect in code, not take it for a comment');
});
