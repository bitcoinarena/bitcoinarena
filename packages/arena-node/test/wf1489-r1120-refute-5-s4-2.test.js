// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r1120-refute-5-s4 (edge of #3127 "one name, one kind, on every file system"): treeFilesOf folds a FILE's path to lower case
// and checks it against files and directories, but never a DIRECTORY against another directory. lib/a.js and LIB/b.js pass every check
// and the trial (an in-memory Map); on a case-insensitive disk (macOS APFS default, Windows NTFS) installPackage writes both into one
// directory, coreTree then reads lib/a.js + lib/b.js, the tree hash no longer matches and the verified, installed game does not load
// (registrationFromPackage: "changed on disk") - so the same signed version is hosted by Linux seats and refused by Mac/Windows seats.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyPackage, installPackage, registrationFromPackage } from '../src/plugin-package.js';
import { verifyEd25519 } from '../src/ed25519.js';
import { treePackage } from './wf1489-r1120-refute-5-s3-common.js';

const ADAPTER = "import { A } from './lib/a.js';\nimport { B } from './LIB/b.js';\n"
  + "export const DECIDE = { name: 'case', decide(moves) { const out = {}; for (const x of moves) out[x.key] = A + B === 3 ? 'DRAW' : 'DRAW'; return out; } };\n";

test('#1489 r1120-refute-5-s4-2: a tree naming lib/ and LIB/ is verified, then does not load from a case-insensitive disk', async () => {
  const probe = mkdtempSync(join(tmpdir(), 'wf1489-s4-2-case-')); writeFileSync(join(probe, 'x'), '');
  const foldingDisk = existsSync(join(probe, 'X'));
  const { pkg, gameId } = treePackage('tree-dir-case', [['adapter.js', ADAPTER], ['lib/a.js', 'export const A = 1;\n'], ['LIB/b.js', 'export const B = 2;\n']]);
  const r = verifyPackage(pkg, { verify: verifyEd25519, want: gameId });
  let loaded = null;
  if (r.ok) {
    const dir = mkdtempSync(join(tmpdir(), 'wf1489-s4-2-'));
    try { const at = installPackage(dir, pkg, gameId); await registrationFromPackage(at, pkg); loaded = 'ok'; } catch (e) { loaded = `${e.code || ''} ${e.message}`.slice(0, 200); }
  }
  console.log('  MEASURED lib/ + LIB/ tree:', JSON.stringify({ foldingDisk, verified: r.ok, why: r.why, loaded }));
  // either the check refuses the two directory spellings (one directory on a case-insensitive disk), or what it verified loads
  assert.ok(!r.ok || loaded === 'ok', `verified (${r.ok}) but the installed tree does not load: ${loaded}`);
  assert.equal(r.ok, false, 'lib/ and LIB/ are one directory on a case-insensitive disk: the check must refuse them as it refuses X.js + x.js');
});
