// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE RELEASE CARRIES EVERY PAGE SCRIPT ITS NODE SERVES (kanban #564, 2026-10-21: "pack the release"): the node's pages draw
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

// THE APPS (kanban #575, 2026-10-21: "the installer downloads the 3 apps automatically, no longer built in"): the release carries
// none of the apps, only their pins (apps.lock.json, apps.files.json), and arena-sdk with its link packages/node_modules/arena-sdk, which
// the downloaded apps' registrations import as arena-sdk/<name>
test('build-release.sh archives the apps\' pins, not the apps, and arena-sdk with its link', () => {
  const sh = readFileSync(join(repo, 'tools/release/build-release.sh'), 'utf8');
  const start = sh.split('\n').findIndex((l) => l.startsWith('git -C "$ROOT" archive "$REF"'));
  const lines = sh.split('\n'); let archive = '';
  for (let i = start; i < lines.length; i++) { archive += ` ${lines[i].replace(/\\$/, '')} `; if (!lines[i].endsWith('\\')) break; }
  const lock = JSON.parse(readFileSync(join(repo, 'apps.lock.json'), 'utf8'));
  const apps = Object.keys(JSON.parse(readFileSync(join(repo, 'apps.files.json'), 'utf8')).apps).map((n) => lock.apps[n].copy.split('/').pop());
  assert.deepEqual(apps.sort(), ['btc-updown', 'nextblock', 'rock-paper-scissors'], 'the three apps a node downloads');
  for (const p of apps) assert.doesNotMatch(archive, new RegExp(` packages/${p} `), `the archive does not carry packages/${p}`);
  for (const f of ['apps.lock.json', 'apps.files.json']) assert.match(archive, new RegExp(` ${f.replace('.', '\\.')} `), `the archive carries ${f}`);
  for (const p of ['arena-sdk', 'node_modules/arena-sdk']) assert.match(archive, new RegExp(` packages/${p} `), `the archive carries packages/${p}`);
  // arena-sdk/manifest-sign points at the developer's signing module: it travels too (it imports only the protocol)
  assert.match(archive, / packages\/arena-donor\/src\/manifest-sign\.js /, 'the archive carries manifest-sign');
  const loop = lines.find((l) => /^for p in arena-node /.test(l));
  assert.ok(loop.split(/[\s;]+/).includes('arena-sdk'), 'arena-sdk\'s tests and node_modules link are dropped');
  assert.match(sh, /rm "\$STAGE\/packages\/node_modules\/arena-sdk"; cp -R "\$STAGE\/packages\/arena-sdk" "\$STAGE\/packages\/node_modules\/arena-sdk"/, 'Windows: a copy, not a link');
});

// nothing the installer loads before the apps are fetched may import one (it would not start from a release without them)
test('no module of the installer or the seat imports an app', () => {
  const files = execFileSync('git', ['ls-files', 'packages/arena-installer/src', 'packages/arena-installer/bin', 'packages/arena-node/src'], { cwd: repo, encoding: 'utf8' }).split('\n').filter((f) => /\.(m?js)$/.test(f));
  const importsApp = files.filter((f) => /(from|import\()\s*['"][./]*\/(nextblock|rock-paper-scissors|btc-updown|hello-world)\//.test(readFileSync(join(repo, f), 'utf8')));
  assert.deepEqual(importsApp, []);
});

// EVERY MODULE THE RELEASE STARTS FINDS WHAT IT IMPORTS (the owner's 2026.1.8 playtest 2026-10-25: the seat's drawn attestor imports
// ../../arena-attestor/src/attestor.js, the archive did not carry it, and the node stopped at ERR_MODULE_NOT_FOUND on every start while
// the installer showed "Installing and starting your node"): from the installer's programs and the seat's main, every relative import
// (static or import()) resolves to a file the archive carries. Not followed: the apps (fetched), and the dev clients' donor, which
// main.js loads only on a node the owner gave ARENA_DEV_WASM_PKG (a developer's node, run from a checkout)
test('every module the node and the installer load is in the archive', () => {
  const sh = readFileSync(join(repo, 'tools/release/build-release.sh'), 'utf8');
  const lines = sh.split('\n'); const start = lines.findIndex((l) => l.startsWith('git -C "$ROOT" archive "$REF"'));
  let archive = '';
  for (let i = start; i < lines.length; i++) { archive += ` ${lines[i].replace(/\\$/, '')} `; if (!lines[i].endsWith('\\')) break; }
  const roots = archive.split(/\s+/).filter((w) => w.startsWith('packages/'));
  const carried = new Set(execFileSync('git', ['ls-files', ...roots], { cwd: repo, encoding: 'utf8' }).split('\n').filter((f) => f && !/^packages\/[^/]+\/test\//.test(f)));
  const skip = /^packages\/(nextblock|rock-paper-scissors|btc-updown|hello-world|arena-donor\/src\/donor\.js$)/;
  const entries = execFileSync('git', ['ls-files', 'packages/arena-installer/bin', 'packages/arena-installer/src'], { cwd: repo, encoding: 'utf8' }).split('\n').filter((f) => /\.m?js$/.test(f));
  const todo = [...entries, 'packages/arena-node/src/main.js']; const seen = new Set(); const missing = [];
  while (todo.length) {
    const f = todo.pop(); if (seen.has(f)) continue; seen.add(f);
    if (!carried.has(f)) { missing.push(f); continue; }
    // code only: a page script inside a template string is the browser's (its own import of ./x is served, not loaded)
    const src = readFileSync(join(repo, f), 'utf8').replace(/`(?:\\[\s\S]|\$\{[^}]*\}|[^`\\])*`/g, '``');
    for (const m of src.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)['"](\.{1,2}\/[^'"]+\.m?js)['"]/gm)) {
      const to = join(f, '..', m[1]);
      if (!skip.test(to)) todo.push(to);
    }
  }
  assert.ok(seen.has('packages/arena-node/src/drawn-attestor.js'), 'the walk reaches the seat');
  assert.deepEqual(missing, [], 'modules the release does not carry');
});
