#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SEASON DRAW (kanban #2623, testnet-stage.bitcoinarena.io/bounty/): 50,000 sat among the reporters with a confirmed report in the season who are
// Telegram or Discord members at draw time, one entry each, places 20,000 / 12,000 / 8,000 / 6,000 / 4,000. Anyone can run it again: the entry list
// (platform usernames) and the seed - the hash of a Bitcoin block named in advance - are published, and this script picks the same 5 winners.
// How: the entries are trimmed, deduplicated and sorted (byte order); for place i = 1..5, sha256("<block hash>:<i>") read as a number, modulo the
// entries still in the draw, picks one, which then leaves the draw.
//   node tools/bounty-draw.mjs --entries entries.txt --block <block hash>      (one entry per line)
//   node tools/bounty-draw.mjs --entries entries.txt --height <height>         (the hash read from mempool.space)
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const PLACES_SATS = Object.freeze([20000, 12000, 8000, 6000, 4000]);

export function drawEntriesList(entries) {
  return [...new Set((entries || []).map((x) => String(x).trim()).filter(Boolean))].sort((a, b) => (Buffer.compare(Buffer.from(a), Buffer.from(b))));
}

export function draw(entries, blockHash, { places = PLACES_SATS } = {}) {
  const hash = String(blockHash || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('the seed is a block hash: 64 hex characters');
  const list = drawEntriesList(entries);
  const left = list.slice();
  const winners = [];
  for (let i = 0; i < places.length && left.length; i++) {
    const h = BigInt(`0x${createHash('sha256').update(`${hash}:${i + 1}`).digest('hex')}`);
    const k = Number(h % BigInt(left.length));
    winners.push({ place: i + 1, entry: left[k], sats: places[i] });
    left.splice(k, 1);
  }
  const entriesSha256 = createHash('sha256').update(list.join('\n')).digest('hex');
  return { blockHash: hash, entries: list, entriesSha256, winners, method: 'sha256("<blockHash>:<place>") mod entries left, entries deduplicated and byte-sorted' };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : null; };
  const file = arg('entries');
  if (!file) { console.error('usage: bounty-draw.mjs --entries <file> (--block <hash> | --height <n>)'); process.exit(2); }
  let block = arg('block'); const height = arg('height');
  if (!block && height) block = (await (await fetch(`https://mempool.space/api/block-height/${Number(height)}`)).text()).trim();
  const out = draw(readFileSync(file, 'utf8').split('\n'), block);
  console.log(JSON.stringify({ height: height ? Number(height) : null, ...out }, null, 2));
}
