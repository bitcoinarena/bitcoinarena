#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A RELEASE FOR NODES ONLY (2026-10-19: "Publish it on a but unlisted for now, only nodes see it. Later it's going to be
// on public GitHub"): each asset of <dir> split into pieces under Cloudflare Pages' 25 MiB file limit, written beside SHA256SUMS and its
// signature into <page>/release/u/<folder>/v<version>/ - a path no page links; the signed latest.json names it (latest.mjs's 5th argument).
// A node joins the pieces and checks the whole asset's SHA-256 (auto-update.js).
//     node tools/release/unlisted.mjs <version> <dir: assets + SHA256SUMS + SHA256SUMS.sig> <page dir> <folder> <out download.json>
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, copyFileSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
const PIECE = 24 * 1024 * 1024;
const [version, dir, page, folder, outFile] = process.argv.slice(2);
if (!version || !dir || !page || !/^[A-Za-z0-9_-]{8,}$/.test(folder || '') || !outFile) { console.error('usage: unlisted.mjs <version> <dir> <page> <folder (8+ of A-Za-z0-9_-)> <out download.json>'); process.exit(2); }
const rel = `release/u/${folder}/v${version}`;
const to = join(page, rel);
mkdirSync(to, { recursive: true });
const sums = readFileSync(join(dir, 'SHA256SUMS'), 'utf8').trim().split('\n').map((l) => l.trim().split(/\s+\*?/)[1]).filter(Boolean);
const parts = {};
for (const name of sums) {
  const file = join(dir, name);
  const size = statSync(file).size;
  const fd = openSync(file, 'r');
  parts[name] = [];
  for (let off = 0, i = 0; off < size; off += PIECE, i++) {
    const n = Math.min(PIECE, size - off);
    const buf = Buffer.alloc(n); readSync(fd, buf, 0, n, off);
    const piece = `${name}.part${String(i).padStart(2, '0')}`;
    writeFileSync(join(to, piece), buf);
    parts[name].push(piece);
  }
  closeSync(fd);
}
for (const f of ['SHA256SUMS', 'SHA256SUMS.sig']) copyFileSync(join(dir, f), join(to, f));
writeFileSync(outFile, JSON.stringify({ base: `https://testnet.bitcoin-arena.io/${rel}/`, sums: 'SHA256SUMS', sig: 'SHA256SUMS.sig', parts }, null, 2) + '\n');
console.log(`${rel}: ${Object.keys(parts).length} assets in ${Object.values(parts).reduce((a, p) => a + p.length, 0)} pieces`);
