#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE APPS AT THEIR PINS, IN THIS TREE (kanban #569, #575: "the installer downloads the 3 apps automatically, no longer built in").
// bitcoin-arena holds no app: each is its own public repository, pinned in apps.lock.json. This checks each app out at the pinned commit
// into .apps/<repo> (sparse and without the blobs it does not need - never Next Block's 450 MB Unity project; the listed Unity parts are
// the ones the Arena's tests read the bridge against) and places the app where the Arena's seats, tests and page build read it:
// packages/<copy> (apps.lock.json `copy`), the app's own files without its Unity project and the files only its repository needs.
// Those folders are not tracked (.gitignore); each carries .arena-app.json, the marker arena-node's app-fetch.js reads as "placed at
// this pin". Run it once after a clone, and again whenever apps.lock.json moves (the paths and the commit are set every time, cheaply).
//
//     node tools/fetch-apps.mjs [app ...]        (no names: every app of apps.lock.json; CI names the public ones)
import { readFileSync, existsSync, mkdirSync, rmSync, renameSync, cpSync, writeFileSync, statSync, chmodSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const APPS_DIR = join(ROOT, '.apps');
/** Files of an app's repository that are its own and never placed (its repository's ignore list and lock file). */
export const OWN_REPO_ONLY = new Set(['.gitignore', 'package-lock.json']);
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();

/** The files of the checkout at `dir` that are placed in the Arena's tree: all but the Unity project and OWN_REPO_ONLY. */
export const placedFiles = (dir) => git(dir, 'ls-files').split('\n').filter(Boolean).filter((f) => !f.startsWith('unity/') && !OWN_REPO_ONLY.has(f));

/** The app checked out at .apps/<name>, placed at packages/<copy>: whole or not at all, a folder of an older pin replaced. */
export function place(root, name, app) {
  const dir = join(root, '.apps', name), target = join(root, app.copy), stage = `${target}.placing`;
  const files = placedFiles(dir);
  rmSync(stage, { recursive: true, force: true });
  for (const f of files) {
    mkdirSync(dirname(join(stage, f)), { recursive: true });
    cpSync(join(dir, f), join(stage, f));
    if (statSync(join(dir, f)).mode & 0o100) chmodSync(join(stage, f), 0o755);
  }
  writeFileSync(join(stage, '.arena-app.json'), JSON.stringify({ repo: app.repo, commit: app.commit, files: files.length }, null, 2) + '\n');
  // the dependencies of this tree, as the tracked copies' node_modules link gave them (Next Block's own tests and tools import acorn); arena-sdk
  // resolves further up, through packages/node_modules/arena-sdk
  if (existsSync(join(root, 'packages/arena-node/node_modules'))) symlinkSync('../arena-node/node_modules', join(stage, 'node_modules'));
  if (existsSync(target)) {
    // never over files of this repository: a folder that is still tracked here is someone's work, not a placed app
    if (git(root, 'ls-files', '--', app.copy)) { rmSync(stage, { recursive: true, force: true }); throw new Error(`${app.copy} is tracked in this repository: not replaced`); }
    rmSync(target, { recursive: true, force: true });
  }
  renameSync(stage, target);
  return files.length;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const lock = JSON.parse(readFileSync(join(ROOT, 'apps.lock.json'), 'utf8'));
  mkdirSync(APPS_DIR, { recursive: true });
  const only = process.argv.slice(2);
  for (const n of only) if (!lock.apps[n]) { console.error(`no app ${n} in apps.lock.json`); process.exit(2); }
  for (const [name, app] of Object.entries(lock.apps).filter(([n]) => !only.length || only.includes(n))) {
    const dir = join(APPS_DIR, name);
    // the apps a node hosts are public (kanban #575): https, no key; one that is not (arena-app-hello-world) over ssh with this machine's key
    if (!existsSync(join(dir, '.git'))) {
      const clone = (url) => execFileSync('git', ['clone', '--quiet', '--filter=blob:none', '--no-checkout', url, name], { cwd: APPS_DIR, stdio: 'ignore', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
      try { clone(`https://github.com/${app.repo}.git`); } catch { rmSync(dir, { recursive: true, force: true }); clone(`git@github.com:${app.repo}.git`); }
    }
    git(dir, 'sparse-checkout', 'set', '--no-cone', ...app.paths);
    try { git(dir, 'cat-file', '-e', `${app.commit}^{commit}`); } catch { git(dir, 'fetch', '--quiet', '--filter=blob:none', 'origin', app.commit); }
    git(dir, 'checkout', '--quiet', '--detach', app.commit);
    const n = place(ROOT, name, app);
    console.log(`${name} at ${app.commit.slice(0, 12)}: ${n} files in ${app.copy}`);
  }
}
