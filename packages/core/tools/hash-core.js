// sim_wasm_hash: sha256 over every core source file, sorted by path.
//
// The Round Contract's field keeps its historical name but means this. Sorted
// source hashing was chosen over hashing a bundle because a bundle's hash
// depends on the bundler version, and nothing that pins money should have a
// toolchain in its trust path.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = new URL('../src', import.meta.url).pathname;
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (name.endsWith('.js')) files.push(p);
  }
})(ROOT);
files.sort();

const h = createHash('sha256');
for (const f of files) {
  h.update(relative(ROOT, f));
  h.update('\0');
  h.update(readFileSync(f));
  h.update('\0');
}
console.log(h.digest('hex'));
for (const f of files) console.error('  ' + relative(ROOT, f));
