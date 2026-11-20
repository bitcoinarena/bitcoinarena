// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r1120-refute-5-s3: a tree may name a file and a directory alike (x.js and x.js/y.js, both pass treePathRefusal). The
// checks and the trial (an in-memory Map) take it; installPackage then throws EEXIST/EISDIR out of server.js adoptPackage, which does not
// catch it - takeGame throws, autoUpdate records no verdict (no `checked`, no trial refusal) and fetches, checks and trials the same
// developer-signed version again from every source on every sweep, leaving a half-written plugins/<id>/ behind (refused at each start).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyPackage, installPackage } from '../src/plugin-package.js';
import { verifyEd25519 } from '../src/ed25519.js';
import { treePackage, DRAW } from './wf1489-r1120-refute-5-s3-common.js';

test('#1489 r1120-refute-5-s3-2: a verified tree package is refused by the check, never thrown out of installPackage', () => {
  const { pkg, gameId } = treePackage('tree-file-dir', [['adapter.js', DRAW], ['x.js', 'export const a = 1;\n'], ['x.js/y.js', 'export const b = 2;\n']]);
  const r = verifyPackage(pkg, { verify: verifyEd25519, want: gameId });
  let thrown = null;
  if (r.ok) { try { installPackage(mkdtempSync(join(tmpdir(), 'wf1489-s3-2-')), pkg, gameId); } catch (e) { thrown = `${e.code} ${e.message}`.slice(0, 200); } }
  console.log('  MEASURED file+dir tree:', JSON.stringify({ verified: r.ok, why: r.why, thrown }));
  assert.equal(thrown, null, 'verifyPackage passed a tree installPackage cannot write: adoptPackage throws instead of refusing');
});
