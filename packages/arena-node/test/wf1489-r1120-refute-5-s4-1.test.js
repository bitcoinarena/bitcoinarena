// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r1120-refute-5-s4 (huge input, against #3100): the tree scan's comment lexer follows up to STATES_MOST (64) readings at
// once and keys every one of them on every character (each key carries the paren kinds, up to DEPTH_KEPT chars). 60 `(` then 22 lines of `}/(1/` (each a slash it cannot tell, a regex in one reading and a
// division that opens a paren in the other) leave ~60 readings live without crossing 64, and the rest of the file is then lexed ~60 times
// over with a key string built per reading per character: ~1000x the cost of the same bytes without the prefix. checkPackage is
// synchronous (the seat's thread, the owner page's tab), and runs before the trial and its TRIAL_MS deadline, so a signed package within
// TREE_LIMITS (8 MiB) holds the seat's event loop for tens of seconds per offer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyPackage } from '../src/plugin-package.js';
import { verifyEd25519 } from '../src/ed25519.js';
import { TREE_LIMITS, scanTree } from '../src/plugin-check.js';
import { treePackage, DRAW } from './wf1489-r1120-refute-5-s3-common.js';

const SIZE = TREE_LIMITS.fileBytes - 4096;
const body = (prefix) => { const p = prefix + 'a = b;\n'.repeat(Math.ceil(SIZE / 7)); return p.slice(0, SIZE); };
const PREFIX = '('.repeat(60) + '}/(1/\n'.repeat(22);
const enc = (t) => new TextEncoder().encode(t);
const scanMs = (prefix) => { const files = ['h1.js', 'h2.js', 'h3.js'].map((path) => ({ path, bytes: enc(body(prefix)) }));
  const t0 = Date.now(); scanTree(files); return Date.now() - t0; };

test('#1489 r1120-refute-5-s4-1: a tree of three 2 MiB files with a 60-paren, 22-line prefix holds the check (and the seat) far longer than the same bytes', () => {
  const plain = scanMs(''), slow = scanMs(PREFIX);
  // and through the seat's whole check of a signed package carrying that tree (its developer signs it: anyone can be a developer)
  const { pkg, gameId } = treePackage('tree-slow', [['adapter.js', DRAW], ...['h1.js', 'h2.js', 'h3.js'].map((p) => [p, body(PREFIX)])]);
  const t0 = Date.now(); const r = verifyPackage(pkg, { verify: verifyEd25519, want: gameId }); const check = Date.now() - t0;
  console.log('  MEASURED scanTree ms plain/prefixed, verifyPackage ms:', JSON.stringify({ plain, slow, check, ok: r.ok }));
  assert.ok(slow < Math.max(2000, plain * 20), `the tree scan took ${slow} ms (the same bytes without the 60-paren, 22-line prefix: ${plain} ms); the whole check ${check} ms on the seat's thread per offer`);
});
