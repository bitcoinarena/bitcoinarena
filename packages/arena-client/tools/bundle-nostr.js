// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Bundles the Nostr login (nostr/nostr-login.js) into one script the template loads ONLY when a player picks
// "Login with Nostr" (window.ARENA_NOSTR): nostr-tools 2.25.2 (pinned) with its noble/scure dependencies. Kept apart from the
// client bundle, which carries no crypto and no npm code; this file never touches a round's money - it hands the page a seed.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const out = process.env.ARENA_BUNDLE_OUT ? resolve(process.env.ARENA_BUNDLE_OUT, 'arena-nostr.js') : resolve(here, '../dist/arena-nostr.js');
const r = spawnSync(resolve(here, '../node_modules/esbuild/bin/esbuild'), [
  'nostr/entry.js', '--bundle', '--format=iife', '--platform=browser', '--global-name=ARENA_NOSTR', '--minify',
  '--legal-comments=none', '--preserve-symlinks', `--outfile=${out}`,
], { stdio: 'inherit', cwd: resolve(here, '..') });
if (r.status) process.exit(r.status || 1);
