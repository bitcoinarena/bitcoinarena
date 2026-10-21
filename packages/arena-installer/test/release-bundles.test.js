// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE RELEASE CARRIES EVERY PAGE SCRIPT ITS NODE SERVES (kanban #564, the owner 2026-10-21: "pack the release"): the node's pages draw
// only with React now (no fallbacks), so a release without one of packages/arena-web's built bundles is a node with a blank page.
// tools/release/build-release.sh archives the whole of packages/arena-web/dist; each bundle the node and the installer read is tracked
// there (or beside the installer's page), so `git archive` puts it in the asset.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
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

// THE APPS (kanban #569, the owner 2026-10-21: "The node still comes with the 3 apps pre installed, that is a step in the installer where
// all apps are automatically selected"): the installer lists every packages/<app>/app.json of the release, so the release must carry each
// app - and arena-sdk with its link packages/node_modules/arena-sdk, which the apps' registrations import as arena-sdk/<name>
test('build-release.sh archives every app with an app.json, and arena-sdk with its link', () => {
  const sh = readFileSync(join(repo, 'tools/release/build-release.sh'), 'utf8');
  const start = sh.split('\n').findIndex((l) => l.startsWith('git -C "$ROOT" archive "$REF"'));
  const lines = sh.split('\n'); let archive = '';
  for (let i = start; i < lines.length; i++) { archive += ` ${lines[i].replace(/\\$/, '')} `; if (!lines[i].endsWith('\\')) break; }
  const apps = readdirSync(join(repo, 'packages')).filter((d) => existsSync(join(repo, 'packages', d, 'app.json')));
  assert.deepEqual(apps.sort(), ['btc-updown', 'nextblock', 'rock-paper-scissors'], 'the three preinstalled apps');
  for (const p of [...apps, 'arena-sdk', 'node_modules/arena-sdk']) assert.match(archive, new RegExp(` packages/${p} `), `the archive carries packages/${p}`);
  const loop = lines.find((l) => /^for p in arena-node /.test(l));
  // arena-sdk/manifest-sign points at the developer's signing module: it travels too (it imports only the protocol)
  assert.match(archive, / packages\/arena-donor\/src\/manifest-sign\.js /, 'the archive carries manifest-sign');
  for (const p of [...apps, 'arena-sdk']) assert.ok(loop.split(/[\s;]+/).includes(p), `${p}'s tests and node_modules link are dropped`);
  assert.match(sh, /rm "\$STAGE\/packages\/node_modules\/arena-sdk"; cp -R "\$STAGE\/packages\/arena-sdk" "\$STAGE\/packages\/node_modules\/arena-sdk"/, 'Windows: a copy, not a link');
});
