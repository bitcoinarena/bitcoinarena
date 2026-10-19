// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// sim_wasm_hash: sha256 over every core source file, sorted by path.
//
// The Round Contract's field keeps its historical name but means this. Sorted
// source hashing was chosen over hashing a bundle because a bundle's hash
// depends on the bundler version, and nothing that pins money should have a
// toolchain in its trust path.
//
// Also a function now, so the known-good list (`arena-protocol/src/known-games.js`, from each game's manifest)
// and the launchers that publish a round's core take the hash from HERE rather
// than from a value somebody remembered. Run as a command it prints what it
// always printed.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// A FILE PATH, NOT A URL'S PATHNAME (measured on the windows-x64 release's first run: "/D:/a/..." became
// "D:\\D:\\a\\...\\src" and the node did not start); and the hashed names are relative paths with "/" on every system, sorted as such
// - on Windows relative() answers "\\", which would hash another core than the one on Linux and macOS.
const ROOT = fileURLToPath(new URL('../src', import.meta.url));
const relOf = (root, f) => relative(root, f).split(sep).join('/');

export function coreSourceFiles(root = ROOT) {
  const files = [];
  (function walk(dir) {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.js')) files.push(p);
    }
  })(root);
  return files.sort((a, b) => { const x = relOf(root, a), y = relOf(root, b); return x < y ? -1 : x > y ? 1 : 0; });
}

/**
 * The core's sim_wasm_hash, as 64 hex digits - of this tree's core/src, or of another core's source tree laid out the
 * same way (a core kept beside it, core/frozen/<hash>: its hash is computed from its files, never typed).
 */
export function coreHashHex(root = ROOT) {
  const h = createHash('sha256');
  for (const f of coreSourceFiles(root)) {
    h.update(relOf(root, f));
    h.update('\0');
    h.update(readFileSync(f));
    h.update('\0');
  }
  return h.digest('hex');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log(coreHashHex());
  for (const f of coreSourceFiles()) console.error('  ' + relative(ROOT, f));
}
