// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A RANDOM NUMBER FROM A RECENT BITCOIN BLOCK, THAT EVERY NODE CAN REPRODUCE (2026-10-15: "eine Funktion basierend
// auf einem recent bitcoin block eine random Zahl zu generieren, so dass es jede node nachvollziehen kann").
//
// A NAMED BLOCK, A LABEL, A HASH. The number comes from the block at a NAMED height - never "the tip", which two nodes read at two
// moments - and only once that block is buried BLOCK_RANDOM_DEPTH deep, so a reorg that could swap it is already unlikely and every
// node that has seen it reads the same hash. The seed is a tagged hash of the block's hash (the chain's own byte order), its height
// and a label - what the number is for (a round id, a draw's name) - so one block gives independent numbers to independent uses,
// and no number of one use can be replayed as another's.
//
// UNBIASED. A number in [0, n) is drawn by rejection sampling over 64-bit words, never `x mod n` (which favours the low values when
// 2^64 is not a multiple of n); `index` gives a stream of numbers from one seed. Deterministic, integer-only, BigInt throughout:
// the same inputs give the same numbers on every node, in a page and in a game core.
//
// The round beacon (beacon.js, committee-seed.js) is the same idea for one use - a round's randomness; this is the general door.
import { taggedHash, toHex, fromHex } from './hash.js';
import { Writer } from './encode.js';

export const TAG_BLOCK_RANDOM = 'ARENA/v1/BlockRandom';
const TAG_BLOCK_RANDOM_DRAW = 'ARENA/v1/BlockRandomDraw';
/** How deep the named block must be (the tip counts as 1): six, as a census is read. */
export const BLOCK_RANDOM_DEPTH = 6;
export const BLOCK_RANDOM_LABEL_MAX = 128;
/** The widest range a draw takes: 2^53, so a number is also a safe JavaScript integer for a page or a core. */
export const BLOCK_RANDOM_N_MAX = 2n ** 53n;

const brIs32 = (b) => b instanceof Uint8Array && b.length === 32;

/**
 * THE SEED of a block for a label: taggedHash(TAG_BLOCK_RANDOM, block hash (32 bytes, the chain's own byte order - the reverse of
 * the hex an RPC prints) || height (u32) || label (UTF-8, 1..128 bytes)). Throws on a malformed input.
 */
export function blockRandomSeed({ blockHash, height, label }) {
  if (!brIs32(blockHash)) throw new Error('a block random number starts from the block\'s 32-byte hash');
  if (!Number.isInteger(height) || height < 0 || height > 0xffffffff) throw new Error('a block is named by its height, a whole number');
  const l = String(label ?? '');
  const bytes = new TextEncoder().encode(l);
  if (bytes.length < 1 || bytes.length > BLOCK_RANDOM_LABEL_MAX) throw new Error(`a block random number names what it is for in 1 to ${BLOCK_RANDOM_LABEL_MAX} bytes`);
  const w = new Writer();
  w.bytes32(blockHash); w.u32(height); w.str(l);
  return taggedHash(TAG_BLOCK_RANDOM, w.finish());
}

/** The block hash an RPC prints (display hex) as the chain's own bytes: reversed. */
export const blockHashFromDisplay = (hex) => fromHex(String(hex).toLowerCase()).reverse();

/**
 * NUMBER `index` OF A SEED'S STREAM, IN [0, n): 64-bit words H(seed || index || attempt) are drawn until one falls below the
 * largest multiple of n that fits in 2^64; that word mod n is the number - every value of [0, n) exactly as likely. `n` is a
 * BigInt (or an integer) from 1 to 2^53. Answers a BigInt.
 */
export function blockRandomInt(seed, n, index = 0) {
  if (!brIs32(seed)) throw new Error('a draw starts from a 32-byte seed');
  const range = BigInt(n);
  if (range < 1n || range > BLOCK_RANDOM_N_MAX) throw new Error(`a draw is in [0, n) for n from 1 to ${BLOCK_RANDOM_N_MAX}`);
  if (!Number.isInteger(index) || index < 0 || index > 0xffffffff) throw new Error('a draw\'s index is a whole number');
  const space = 2n ** 64n;
  const limit = space - (space % range);
  for (let attempt = 0; attempt < 1024; attempt++) {
    const w = new Writer();
    w.bytes32(seed); w.u32(index); w.u32(attempt);
    const h = taggedHash(TAG_BLOCK_RANDOM_DRAW, w.finish());
    let x = 0n;
    for (let i = 0; i < 8; i++) x = (x << 8n) | BigInt(h[i]);
    if (x < limit) return x % range;
  }
  // unreachable in practice: every attempt is rejected with probability below 1/2
  throw new Error('no draw fell inside the range in 1024 attempts');
}

/** `count` numbers of the stream, indexes 0 .. count-1. */
export function blockRandomStream(seed, n, count) {
  if (!Number.isInteger(count) || count < 1 || count > 1000) throw new Error('a stream is 1 to 1000 numbers');
  return Array.from({ length: count }, (_, i) => blockRandomInt(seed, n, i));
}

/**
 * MAY THIS BLOCK BE USED YET? Only when it is buried `depth` deep under `tipHeight` (the tip counts as 1). Answers { ok, depth } or
 * { ok: false, why, ready } - `ready` the tip height at which it will be.
 */
export function blockRandomReady({ height, tipHeight, depth = BLOCK_RANDOM_DEPTH }) {
  if (!Number.isInteger(height) || !Number.isInteger(tipHeight)) return { ok: false, why: 'no height or no tip to compare' };
  const buried = tipHeight - height + 1;
  if (buried >= depth) return { ok: true, depth: buried };
  return { ok: false, ready: height + depth - 1, why: buried < 1 ? `block ${height} is not mined yet (tip ${tipHeight})`
    : `block ${height} is ${buried} deep and a block random number waits for ${depth}: from tip ${height + depth - 1}` };
}

/**
 * THE WHOLE ANSWER, as a seat or a page gives it: the block's height and hash (display hex), the seed, and the numbers. A reader
 * recomputes it from its own chain view (blockRandomStands).
 */
export function blockRandom({ blockHashDisplay, height, label, n, count = 1 }) {
  const seed = blockRandomSeed({ blockHash: blockHashFromDisplay(blockHashDisplay), height, label });
  return { height, blockHash: String(blockHashDisplay).toLowerCase(), label: String(label), n: String(BigInt(n)), seed: toHex(seed),
    numbers: blockRandomStream(seed, n, count).map(String) };
}

/** DOES A CLAIMED ANSWER STAND on this reader's own chain (`blockHashDisplay` at its height)? { ok } or why not. */
export function blockRandomStands(claimed, { blockHashDisplay }) {
  if (!claimed || typeof claimed !== 'object') return { ok: false, why: 'no answer to check' };
  if (String(claimed.blockHash).toLowerCase() !== String(blockHashDisplay).toLowerCase())
    return { ok: false, why: `block ${claimed.height} is ${String(blockHashDisplay).slice(0, 16)} on this chain, and the answer names ${String(claimed.blockHash).slice(0, 16)}` };
  let mine;
  try { mine = blockRandom({ blockHashDisplay, height: claimed.height, label: claimed.label, n: claimed.n, count: (claimed.numbers || []).length || 1 }); }
  catch (e) { return { ok: false, why: e.message }; }
  if (mine.seed !== claimed.seed || mine.numbers.join(',') !== (claimed.numbers || []).join(',')) return { ok: false, why: 'the numbers are not the ones this block gives' };
  return { ok: true };
}
