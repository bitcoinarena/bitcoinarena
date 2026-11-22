// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3325 (regression of #739): no tracked symlink may point to an absolute path - such links point into one machine's directories
// (node_modules, an app checkout, a scratchpad) and break every fresh checkout (fetch-apps ENOTDIR, missing dependencies).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('#3325 no tracked symlink has an absolute target', (t) => {
  const here = fileURLToPath(new URL('.', import.meta.url));
  let root;
  try { root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: here, encoding: 'utf8' }).trim(); } catch { t.skip('not a git checkout'); return; }
  const links = execFileSync('git', ['ls-files', '-s'], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 }).split('\n').filter((l) => l.startsWith('120000 '));
  const bad = [];
  for (const l of links) {
    const [meta, path] = l.split('\t'); const hash = meta.split(' ')[1];
    const target = execFileSync('git', ['cat-file', '-p', hash], { cwd: root, encoding: 'utf8' });
    if (target.startsWith('/')) bad.push(`${path} -> ${target}`);
  }
  assert.deepEqual(bad, [], 'tracked absolute symlinks: ' + bad.join(', '));
});
