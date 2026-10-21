#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE FILES A NODE DOWNLOADS OF EACH APP (kanban #575): apps.files.json, every file of each app's copy a node takes (all but its tests and
// the tracked node_modules link - what the release used to carry) with its SHA-256, for the commit apps.lock.json pins. The copies are
// the apps at their pins byte for byte (arena-client/test/apps-pinned), so these are the app's files at that commit; arena-node's
// app-fetch.js downloads them from the app's repository and refuses any other bytes. Only apps with an app.json (the ones a node hosts).
//
//     node tools/pin-apps.mjs        (again whenever apps.lock.json moves; arena-node/test/app-fetch checks it is current)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** apps.files.json as the copies in the tree at `root` make it. */
export function appsFiles(root = ROOT) {
  const lock = JSON.parse(readFileSync(join(root, 'apps.lock.json'), 'utf8'));
  const apps = {};
  for (const [name, app] of Object.entries(lock.apps)) {
    if (!existsSync(join(root, app.copy, 'app.json'))) continue;
    const files = {}, exec = [];
    for (const line of execFileSync('git', ['ls-files', '-s', '--', app.copy], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean)) {
      const [meta, full] = line.split('\t');
      const mode = meta.split(' ')[0];
      const path = full.slice(app.copy.length + 1);
      if (path === 'node_modules' || path.startsWith('test/')) continue;
      if (mode !== '100644' && mode !== '100755') throw new Error(`${full}: mode ${mode} - a node downloads plain files only`);
      files[path] = createHash('sha256').update(readFileSync(join(root, full))).digest('hex');
      if (mode === '100755') exec.push(path);
    }
    apps[name] = { commit: app.commit, files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1))), exec: exec.sort() };
  }
  return { about: 'What a node downloads of each app at its pinned commit (kanban #575): every file with its SHA-256. Written by tools/pin-apps.mjs from the copies; never by hand.', apps };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = appsFiles();
  writeFileSync(join(ROOT, 'apps.files.json'), JSON.stringify(out, null, 2) + '\n');
  for (const [name, a] of Object.entries(out.apps)) console.log(`${name} at ${a.commit.slice(0, 12)}: ${Object.keys(a.files).length} files`);
}
