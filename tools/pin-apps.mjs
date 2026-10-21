#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE FILES A NODE DOWNLOADS OF EACH APP (kanban #575): apps.files.json, every file of each app a node takes at the commit apps.lock.json
// pins (all but its tests, its Unity project and the files only its repository needs - what the release used to carry) with its SHA-256.
// Read from the apps' own checkouts at the pins (.apps/<repo>, tools/fetch-apps.mjs); arena-node's app-fetch.js downloads these files from
// each app's repository and refuses any other bytes. Only apps with an app.json (the ones a node hosts).
//
//     node tools/fetch-apps.mjs && node tools/pin-apps.mjs        (again whenever apps.lock.json moves; arena-node/test/app-fetch checks it)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OWN_REPO_ONLY } from './fetch-apps.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** apps.files.json as the apps' checkouts in .apps/ of the tree at `root` make it. */
export function appsFiles(root = ROOT) {
  const lock = JSON.parse(readFileSync(join(root, 'apps.lock.json'), 'utf8'));
  const apps = {};
  for (const [name, app] of Object.entries(lock.apps)) {
    const dir = join(root, '.apps', name);
    if (!existsSync(join(dir, '.git'))) throw new Error(`no checkout of ${name}: run node tools/fetch-apps.mjs`);
    if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim() !== app.commit) throw new Error(`${name} is not checked out at its pin: run node tools/fetch-apps.mjs`);
    if (!existsSync(join(dir, 'app.json'))) continue;
    const files = {}, exec = [];
    for (const line of execFileSync('git', ['ls-files', '-s'], { cwd: dir, encoding: 'utf8' }).split('\n').filter(Boolean)) {
      const [meta, path] = line.split('\t');
      const mode = meta.split(' ')[0];
      if (path.startsWith('test/') || path.startsWith('unity/') || OWN_REPO_ONLY.has(path)) continue;
      if (mode !== '100644' && mode !== '100755') throw new Error(`${name}/${path}: mode ${mode} - a node downloads plain files only`);
      files[path] = createHash('sha256').update(readFileSync(join(dir, path))).digest('hex');
      if (mode === '100755') exec.push(path);
    }
    apps[name] = { commit: app.commit, files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1))), exec: exec.sort() };
  }
  return { about: 'What a node downloads of each app at its pinned commit (kanban #575): every file with its SHA-256. Written by tools/pin-apps.mjs from the apps\' checkouts; never by hand.', apps };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = appsFiles();
  writeFileSync(join(ROOT, 'apps.files.json'), JSON.stringify(out, null, 2) + '\n');
  for (const [name, a] of Object.entries(out.apps)) console.log(`${name} at ${a.commit.slice(0, 12)}: ${Object.keys(a.files).length} files`);
}
