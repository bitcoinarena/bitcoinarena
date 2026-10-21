// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE RELEASE CARRIES EVERY PAGE SCRIPT ITS NODE SERVES (kanban #564, the owner 2026-10-21: "pack the release"): the node's pages draw
// only with React now (no fallbacks), so a release without one of packages/arena-web's built bundles is a node with a blank page.
// tools/release/build-release.sh archives the whole of packages/arena-web/dist; each bundle the node and the installer read is tracked
// there (or beside the installer's page), so `git archive` puts it in the asset.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const repo = fileURLToPath(new URL('../../..', import.meta.url));
const tracked = new Set(execFileSync('git', ['ls-files', 'packages/arena-web/dist', 'packages/arena-installer/www'], { cwd: repo, encoding: 'utf8' }).split('\n').filter(Boolean));

test('build-release.sh archives the whole of arena-web/dist', () => {
  const sh = readFileSync(join(repo, 'tools/release/build-release.sh'), 'utf8');
  const line = sh.split('\n').find((l) => l.startsWith('git -C "$ROOT" archive "$REF"'));
  assert.ok(line, 'the archive step');
  assert.match(line, / packages\/arena-web\/dist /);
  assert.match(line, / packages\/arena-installer /);
});

test('every bundle the node and the installer serve is tracked, so the release carries it', () => {
  const server = readFileSync(join(repo, 'packages/arena-node/src/server.js'), 'utf8');
  for (const [path, file] of [['/owner/react.js', 'owner.js'], ['/owner/react.css', 'arena.css'], ['/dashboard/react.js', 'dashboard.js'], ['/rounds/react.js', 'rounds.js'], ['/emergency/react.js', 'emergency.js']]) {
    assert.ok(server.includes(`'${path}'`), `the node serves ${path}`);
    assert.ok(tracked.has(`packages/arena-web/dist/${file}`), `packages/arena-web/dist/${file} is tracked`);
  }
  const wizard = readFileSync(join(repo, 'packages/arena-installer/src/wizard.js'), 'utf8');
  assert.match(wizard, /new URL\('\.\.\/www\/wizard\.js', import\.meta\.url\)/);
  assert.ok(tracked.has('packages/arena-installer/www/wizard.js'), 'the installer\'s steps are tracked');
});
