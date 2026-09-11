// sim_wasm_hash: sha256 over every core source file, sorted by path.
//
// The Round Contract's field keeps its historical name but means this. Sorted
// source hashing was chosen over hashing a bundle because a bundle's hash
// depends on the bundler version, and nothing that pins money should have a
// toolchain in its trust path.
//
// Also a function now, so the known-good list (`protocol/src/known-cores.js`)
// and the launchers that publish a round's core take the hash from HERE rather
// than from a value somebody remembered. Run as a command it prints what it
// always printed.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../src', import.meta.url).pathname;

export function coreSourceFiles() {
  const files = [];
  (function walk(dir) {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.js')) files.push(p);
    }
  })(ROOT);
  return files.sort();
}

/** The core's sim_wasm_hash, as 64 hex digits. */
export function coreHashHex() {
  const h = createHash('sha256');
  for (const f of coreSourceFiles()) {
    h.update(relative(ROOT, f));
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
