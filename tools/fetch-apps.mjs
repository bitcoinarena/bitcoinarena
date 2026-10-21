#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE APPS' OWN FILES THE ARENA READS, AT A PINNED COMMIT (kanban #569, the owner 2026-10-21: "Do not leave the Unity project in
// bitcoin-arena"): Next Block's Unity project is its own repository's (a tester/arena-app-next-block). The Arena's tests read the
// page's side of the bridge against the client's (the jslib, a few C# files); this checks those parts out of the app at the commit
// apps.lock.json names, into .apps/<repo> (not tracked) - sparse and without the blobs it does not need, never the 450 MB project.
//
//     node tools/fetch-apps.mjs        (again after apps.lock.json moves: the paths and the commit are set every time, cheaply)
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const APPS_DIR = join(ROOT, '.apps');
const lock = JSON.parse(readFileSync(join(ROOT, 'apps.lock.json'), 'utf8'));
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  mkdirSync(APPS_DIR, { recursive: true });
  for (const [name, app] of Object.entries(lock.apps)) {
    const dir = join(APPS_DIR, name);
    if (!existsSync(join(dir, '.git'))) {
      git(APPS_DIR, 'clone', '--quiet', '--filter=blob:none', '--no-checkout', `git@github.com:${app.repo}.git`, name);
    }
    git(dir, 'sparse-checkout', 'set', '--no-cone', ...app.paths);
    try { git(dir, 'cat-file', '-e', `${app.commit}^{commit}`); } catch { git(dir, 'fetch', '--quiet', '--filter=blob:none', 'origin', app.commit); }
    git(dir, 'checkout', '--quiet', '--detach', app.commit);
    console.log(`${name} at ${app.commit.slice(0, 12)}: ${app.paths.join(' ')}`);
  }
}
