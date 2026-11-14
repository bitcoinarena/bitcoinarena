#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SEASON DRAW (kanban #2623, #2641, testnet-stage.bitcoinarena.io/bounty/#draw): 50,000 sat among the reporters with a confirmed report in the week
// who are members of Telegram, Discord or Armada at draw time, one entry per person, places 20,000 / 12,000 / 8,000 / 6,000 / 4,000. Anyone can run it
// again: the entry list (platform usernames) is published, and the seed is the hash of THE FIRST BITCOIN (MAINNET) BLOCK WHOSE HEADER TIME IS AFTER THE
// WEEK'S END (Daniel 2026-11-14: "Erster Block nach Week 2"; a block stamped exactly at the end does not count), read from mempool.space.
// How: the entries are trimmed, deduplicated and sorted (byte order); for place i = 1..5, sha256("<block hash>:<i>") read as a number, modulo the
// entries still in the draw, picks one, which then leaves the draw.
//   node tools/bounty-draw.mjs --entries entries.txt --block <block hash>      (one entry per line)
//   node tools/bounty-draw.mjs --entries entries.txt --height <height>         (the hash read from mempool.space)
//   node tools/bounty-draw.mjs --entries entries.txt --after 2026-11-21T07:12:35Z   (the seed block found by the rule above)
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

/**
 * THE SEED BLOCK: the lowest height whose header time (seconds) is after `endMs` - a time equal to the end does not count. `tip()` the chain's height,
 * `hashAt(h)` and `timeOf(hash)` its headers. Header times are not in order (each must only be above the median of the 11 before it), so a binary search
 * first finds a block at least `marginS` (3 h) before the end, then every height from there is read up. null when no block is after the end yet.
 */
export async function seedBlockAfter(endMs, { tip, hashAt, timeOf, marginS = 3 * 3600 }) {
  if (!Number.isFinite(endMs)) throw new Error('the end is a time');
  const t = async (h) => timeOf(await hashAt(h));
  const top = await tip();
  let lo = 0, hi = top;
  while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if ((await t(mid)) * 1000 <= endMs - marginS * 1000) lo = mid; else hi = mid - 1; }
  for (let h = lo; h <= top; h++) { const hash = await hashAt(h); const time = await timeOf(hash); if (time * 1000 > endMs) return { height: h, hash, time }; }
  return null;
}
const MEMPOOL = 'https://mempool.space/api';
export const mempoolChain = (fetchFn = fetch) => ({
  tip: async () => Number(await (await fetchFn(`${MEMPOOL}/blocks/tip/height`)).text()),
  hashAt: async (h) => (await (await fetchFn(`${MEMPOOL}/block-height/${h}`)).text()).trim(),
  // the header's own time field (mempool.space's `timestamp` is the header time, not when the block was seen)
  timeOf: async (hash) => Number((await (await fetchFn(`${MEMPOOL}/block/${hash}`)).json()).timestamp),
});

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : null; };
  const file = arg('entries');
  if (!file) { console.error('usage: bounty-draw.mjs --entries <file> (--block <hash> | --height <n>)'); process.exit(2); }
  let block = arg('block'); let height = arg('height'); let seed = null;
  if (!block && height) block = (await (await fetch(`https://mempool.space/api/block-height/${Number(height)}`)).text()).trim();
  if (!block && arg('after')) { seed = await seedBlockAfter(Date.parse(arg('after')), mempoolChain());
    if (!seed) { console.error(`no block after ${arg('after')} yet`); process.exit(3); } block = seed.hash; height = seed.height; }
  const out = draw(readFileSync(file, 'utf8').split('\n'), block);
  console.log(JSON.stringify({ height: height ? Number(height) : null, ...(seed ? { seedRule: `first block with header time after ${arg('after')}`, blockTime: new Date(seed.time * 1000).toISOString() } : {}), ...out }, null, 2));
}
