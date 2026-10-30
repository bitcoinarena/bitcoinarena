#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE NEWEST RELEASE, FOR THE OWNER PAGE ("a new release is available"). Writes <out>/latest.json from a release's
// SHA256SUMS: its version, tag, commit, release page and assets; tools/release/sign.sh <out> <key> latest.json signs it with the
// release key, and both are published at https://testnet.bitcoin-arena.io/release/. A seat reads them (/owner/version) and offers
// the update only when the signature verifies.
//
//     node tools/release/latest.mjs <version> <commit> <dir holding SHA256SUMS> <out dir>
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
// [download.json]: where nodes fetch the assets (tools/release/unlisted.mjs) - signed with the rest
const [version, commit, dir, out, downloadFile] = process.argv.slice(2);
if (!version || !/^[0-9a-f]{40}$/.test(commit || '') || !dir || !out) { console.error('usage: latest.mjs <version> <commit> <dir with SHA256SUMS> <out dir>'); process.exit(2); }
const assets = Object.fromEntries(readFileSync(`${dir}/SHA256SUMS`, 'utf8').trim().split('\n').map((l) => l.trim().split(/\s+\*?/)).filter((p) => p.length === 2).map(([h, n]) => [n, h]));
const tag = `v${version}`;
const download = downloadFile ? JSON.parse(readFileSync(downloadFile, 'utf8')) : undefined;
const latest = { network: 'testnet4', version, tag, commit, publishedMs: Date.now(), release: `https://github.com/bitcoin-arena/bitcoin-arena/releases/tag/${tag}`, assets, ...(download ? { download } : {}) };
mkdirSync(out, { recursive: true });
writeFileSync(`${out}/latest.json`, JSON.stringify(latest, null, 2) + '\n');
console.log(`${out}/latest.json: ${tag}, ${Object.keys(assets).length} assets`);
