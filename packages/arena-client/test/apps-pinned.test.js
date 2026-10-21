// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ARENA READS EACH APP AS ITS OWN REPOSITORY HAS IT, AT THE PINNED COMMIT (kanban #569, #575): bitcoin-arena tracks no app; each app's
// folder (apps.lock.json `copy`) is placed by tools/fetch-apps.mjs from the app's checkout at the pinned commit, and is byte for byte that
// checkout's files - but Next Block's Unity project, which only its own repository holds, and the files only a repository of its own
// needs (.gitignore, package-lock.json). A folder from an older pin, or one edited by hand, fails here. Needs `node tools/fetch-apps.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { placedFiles } from '../../../tools/fetch-apps.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const lock = JSON.parse(readFileSync(join(ROOT, 'apps.lock.json'), 'utf8'));
const lines = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).split('\n').filter(Boolean);
const walk = (dir, at = '') => readdirSync(join(dir, at), { withFileTypes: true }).flatMap((e) => {
  const p = at ? `${at}/${e.name}` : e.name;
  return e.isDirectory() ? walk(dir, p) : [p];
});

for (const [name, app] of Object.entries(lock.apps)) {
  test(`${name}: ${app.copy} is the app at ${app.commit.slice(0, 12)}, and this repository tracks none of it`, () => {
    const dir = join(ROOT, '.apps', name);
    assert.ok(existsSync(join(dir, '.git')), `no checkout of ${name}: run node tools/fetch-apps.mjs`);
    assert.equal(lines(dir, 'rev-parse', 'HEAD')[0], app.commit, `${name} is not checked out at the pinned commit: run node tools/fetch-apps.mjs`);
    assert.deepEqual(lines(ROOT, 'ls-files', '--', app.copy), [], `${app.copy} is not tracked here: the app's repository is its only source`);
    const marker = JSON.parse(readFileSync(join(ROOT, app.copy, '.arena-app.json'), 'utf8'));
    assert.deepEqual([marker.repo, marker.commit], [app.repo, app.commit], `${app.copy} was placed for another pin: run node tools/fetch-apps.mjs`);
    const placed = walk(join(ROOT, app.copy)).filter((f) => f !== '.arena-app.json' && f.split('/')[0] !== 'node_modules');
    const own = placedFiles(dir);
    assert.deepEqual([...placed].sort(), [...own].sort(), 'the same files');
    const differ = placed.filter((f) => !readFileSync(join(ROOT, app.copy, f)).equals(readFileSync(join(dir, f))));
    assert.deepEqual(differ, [], 'the same bytes');
  });
}

test('the apps\' folders are ignored, so none is added back by accident', () => {
  const ignored = (path) => { try { execFileSync('git', ['check-ignore', '-q', '--no-index', path], { cwd: ROOT, stdio: 'ignore' }); return true; } catch { return false; } };
  for (const app of Object.values(lock.apps)) assert.ok(ignored(`${app.copy}/app.json`), `${app.copy} is ignored`);
});
