#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ARENA PINS AN APP'S WEBGL CLIENT (kanban #569, 2026-10-21: "The Arena page loads that build like any other app client,
// hash-pinned"). Next Block publishes its WebGL client as a GitHub release of bitcoin-arena/arena-app-next-block (its
// tools/publish-webgl.mjs: the files, and webgl.json naming each one's SHA-256). This takes that release, recomputes every file's SHA-256
// - and for a brotli .unityweb the SHA-256 of its unpacked bytes, which is what a browser hands the page - refuses any file that is not
// what webgl.json says, and writes the Arena's own pin: src/arena-ui/apps/nextblock.webgl-pin.json. The page is built with these hashes
// inside it (tools/build-arena-page.mjs) and runs no file of the client whose bytes do not hash to them.
//
//     node tools/pin-app-webgl.mjs <release tag> [<cache dir>]      (the release's files are kept in <cache dir>/<tag>/, unflattened)
import { readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync, existsSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { brotliDecompressSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'bitcoin-arena/arena-app-next-block';
export const PIN = join(ROOT, 'src/arena-ui/apps/nextblock.webgl-pin.json');
const sha = (b) => createHash('sha256').update(b).digest('hex');

/** Every file of an unflattened release folder checked against its webgl.json; the pin, or a refusal by name. */
export function pinOf(dir, tag) {
  const manifest = JSON.parse(readFileSync(join(dir, 'webgl.json'), 'utf8'));
  const files = {};
  for (const [rel, f] of Object.entries(manifest.files)) {
    const b = readFileSync(join(dir, rel));
    if (b.length !== f.bytes || sha(b) !== f.sha256) throw new Error(`${tag}: ${rel} is not the file webgl.json names`);
    const pin = { sha256: f.sha256 };
    if (rel.endsWith('.unityweb')) {
      const u = sha(brotliDecompressSync(b));
      if (u !== f.unpackedSha256) throw new Error(`${tag}: ${rel} unpacks to other bytes than webgl.json names`);
      pin.unpackedSha256 = u;
    }
    files[rel] = pin;
  }
  return { app: manifest.app, title: manifest.title, repo: REPO, release: tag, build: manifest.build, productVersion: manifest.productVersion, files };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [tag, cache = join(tmpdir(), 'arena-app-webgl')] = process.argv.slice(2);
  if (!tag) { console.error('usage: pin-app-webgl.mjs <release tag> [<cache dir>]'); process.exit(2); }
  const dir = join(cache, tag);
  if (existsSync(dir)) rmSync(dir, { recursive: true });
  mkdirSync(dir, { recursive: true });
  execFileSync('gh', ['release', 'download', tag, '--repo', REPO, '--dir', dir], { stdio: 'inherit' });
  // an asset's name is its path with "/" as "__"
  for (const n of readdirSync(dir)) if (n.includes('__')) { const to = join(dir, ...n.split('__')); mkdirSync(dirname(to), { recursive: true }); renameSync(join(dir, n), to); }
  const pin = pinOf(dir, tag);
  mkdirSync(dirname(PIN), { recursive: true });
  writeFileSync(PIN, JSON.stringify(pin, null, 1) + '\n');
  console.log(`pinned ${tag} (${pin.productVersion}): ${Object.keys(pin.files).length} files -> ${PIN.slice(ROOT.length + 1)}; the release's files in ${dir}`);
}
