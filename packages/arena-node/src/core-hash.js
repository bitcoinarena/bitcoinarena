// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A CORE'S HASH, ONE RULE FOR THE NODE THAT CHECKS IT AND THE APP THAT NAMES IT (kanban #691, 2026-10-26: "All apps should reference
// the SDK and not use local copies"). The sandbox (core-sandbox.js) checks a core's files against its hash before a line of it runs;
// an app names that hash in its manifest. Both had the rule written out - here and in Next Block's tools/hash-core.js, which the
// sandbox's comment named as the original - and the two sorted differently on Windows (the node by absolute path with "\\", the
// app by relative path with "/"). Now the app takes it from arena-sdk/core-hash, and the node from here:
//
//   a tree (a core with `root`): every .js file below root, sorted by its path relative to root with "/" on every system, hashed
//       as `rel \0 bytes \0` for each - the Round Contract's sim_wasm_hash (sorted sources, never a bundle: a bundle's hash
//       depends on the bundler version, and nothing that pins money should have a toolchain in its trust path)
//   one file (a core with only `url`): sha256 of its bytes
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// A FILE PATH, NOT A URL'S PATHNAME (measured on the windows-x64 release's first run: "/D:/a/..." became "D:\\D:\\a\\...\\src" and
// the node did not start): a file: URL is turned into a path here, a path is taken as it is
const pathOf = (p) => (p instanceof URL || String(p).startsWith('file:') ? fileURLToPath(p) : String(p));
/** A file's name inside the core: its path relative to root, "/" on every system. */
export const coreRelPath = (root, file) => relative(pathOf(root), file).split(sep).join('/');

/** The core's files below `root`: every .js, as absolute paths, in the order they are hashed (by coreRelPath). */
export function coreTreeFiles(root) {
  const base = pathOf(root), files = [];
  (function walk(dir) {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.js')) files.push(p);
    }
  })(base);
  return files.sort((a, b) => { const x = coreRelPath(base, a), y = coreRelPath(base, b); return x < y ? -1 : x > y ? 1 : 0; });
}

/** A tree's hash and its files: { hash (64 hex), files: Map(rel -> bytes) } - each file read once. */
export function coreTree(root) {
  const base = pathOf(root), h = createHash('sha256'), files = new Map();
  for (const f of coreTreeFiles(base)) {
    const rel = coreRelPath(base, f), bytes = readFileSync(f);
    h.update(rel); h.update('\0'); h.update(bytes); h.update('\0');
    files.set(rel, bytes);
  }
  return { hash: h.digest('hex'), files };
}

/** A tree's hash, 64 hex digits. */
export const coreTreeHashHex = (root) => coreTree(root).hash;
/** The hash of a core that is one file, from its bytes (the node hashes the bytes it then runs, read once): 64 hex digits. */
export const coreBytesHashHex = (bytes) => createHash('sha256').update(bytes).digest('hex');
/** The hash of a core that is one file, from its path or file: URL. */
export const coreFileHashHex = (file) => coreBytesHashHex(readFileSync(pathOf(file)));
