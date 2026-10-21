// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ARENA HOLDS EACH APP AS ITS OWN REPOSITORY HAS IT, AT THE PINNED COMMIT (kanban #569): every file of each app's copy in bitcoin-arena
// (apps.lock.json `copy`) is byte for byte the app's file at the commit apps.lock.json names, and every file of the app is in the copy -
// but Next Block's Unity project, which only its own repository holds, and the files only a repository of its own needs (.gitignore,
// package-lock.json). So the release, which packs the copies, ships exactly the pinned apps. Needs `node tools/fetch-apps.mjs` first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const lock = JSON.parse(readFileSync(join(ROOT, 'apps.lock.json'), 'utf8'));
const lines = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).split('\n').filter(Boolean);
const OWN_REPO_ONLY = new Set(['.gitignore', 'package-lock.json']);

for (const [name, app] of Object.entries(lock.apps)) {
  test(`${name}: bitcoin-arena's ${app.copy} is the app at ${app.commit.slice(0, 12)}`, () => {
    const dir = join(ROOT, '.apps', name);
    assert.ok(existsSync(join(dir, '.git')), `no checkout of ${name}: run node tools/fetch-apps.mjs`);
    assert.equal(lines(dir, 'rev-parse', 'HEAD')[0], app.commit, `${name} is not checked out at the pinned commit: run node tools/fetch-apps.mjs`);
    const copy = lines(ROOT, 'ls-files', '--', app.copy).map((f) => f.slice(app.copy.length + 1))
      .filter((f) => f !== 'node_modules');   // a link to the dependencies of this tree, not a file of the app
    const own = lines(dir, 'ls-files').filter((f) => !f.startsWith('unity/') && !OWN_REPO_ONLY.has(f));
    assert.deepEqual([...copy].sort(), [...own].sort(), 'the same files');
    const differ = copy.filter((f) => !readFileSync(join(ROOT, app.copy, f)).equals(readFileSync(join(dir, f))));
    assert.deepEqual(differ, [], 'the same bytes');
  });
}
