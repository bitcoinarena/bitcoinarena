// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Bundles the page curve into one file the template can load as a script.
//
// The client bundle itself still carries no crypto. This file is the
// injection: the same `@noble/curves` secp256k1 the daemons use, assigned to
// `BLWP_CURVE` so `playerFor` can name a real key.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { statSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, '../src/page-curve.js');
// ARENA_BUNDLE_OUT builds into another directory, so a test can build this
// source and compare it with what is committed; unset, it writes dist/ as ever.
const out = process.env.ARENA_BUNDLE_OUT ? resolve(process.env.ARENA_BUNDLE_OUT, 'blwp-curve.js') : resolve(here, '../dist/blwp-curve.js');
const bin = resolve(here, '../node_modules/esbuild/bin/esbuild');

const r = spawnSync(bin, [
  src, '--bundle', '--format=iife', '--platform=browser',
  '--global-name=BLWP_CURVE_EXPORTS',
  '--footer:js=globalThis.BLWP_CURVE=BLWP_CURVE_EXPORTS.pageCurve;',
  // THE SAME BYTES WHEREVER THE CHECKOUT IS (2026-09-25): esbuild writes each module's path, relative to its working
  // directory, into the bundle - so it runs from this package, and keeps a symlinked node_modules' own path. Measured
  // before: dist was built from the repository root ("packages/arena-client/src/..."), bundle-fresh builds from this
  // package ("src/..."), and a worktree whose node_modules is a symlink wrote a path through it - three different bundles
  // of one source, and bundle-fresh red on the curve whatever was committed.
  '--preserve-symlinks',
  `--outfile=${out}`,
], { stdio: 'inherit', cwd: resolve(here, '..') });
if (r.status) process.exit(r.status || 1);

const kb = (statSync(out).size / 1024).toFixed(1);
console.log(`dist/blwp-curve.js  ${kb} KB`);
