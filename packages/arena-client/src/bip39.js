// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE PLAYER'S 32 BYTES AS 24 WORDS HE CAN WRITE DOWN, AND BACK AGAIN (BIP-39).
//
// This is real Bitcoin: the phrase has to restore the same wallet in any other tool, so the encoding is
// BIP-39's and not ours. 256 bits of entropy - the seed `tabSeed` already mints, unchanged, never
// re-minted to make the mapping prettier - plus an 8-bit checksum, read 11 bits at a time, is 24 words.
//
// THE CHECKSUM IS THE POINT OF THE LAST WORD. Without it a mistyped word gives a different VALID seed and
// the player restores an empty wallet with no error anywhere. With it, a wrong word is a wrong phrase and
// `seedFromPhrase` refuses instead of handing back 32 plausible bytes.
import { sha256 } from '../../arena-protocol/src/hash.js';
import { BIP39_ENGLISH } from './bip39-wordlist.js';

export const PHRASE_WORDS = 24;          // 256 bits of entropy + 8 of checksum, 11 bits a word
const ENTROPY_BYTES = 32;
const INDEX_OF = new Map(BIP39_ENGLISH.map((w, i) => [w, i]));

const bitsOf = (bytes) => {
  let s = '';
  for (const b of bytes) s += b.toString(2).padStart(8, '0');
  return s;
};

/** The first `ENTROPY_BYTES / 4` bits of sha256(entropy) - 8 bits for a 32-byte seed. */
const checksumBits = (seed) => bitsOf(sha256(seed)).slice(0, (seed.length * 8) / 32);

/**
 * 32 BYTES -> 24 WORDS. Refuses anything that is not the seed this wallet uses, rather than padding it.
 */
export function phraseFromSeed(seed) {
  if (!(seed instanceof Uint8Array) || seed.length !== ENTROPY_BYTES)
    return { ok: false, why: `a seed is ${ENTROPY_BYTES} bytes and that is ${seed && seed.length}` };
  const bits = bitsOf(seed) + checksumBits(seed);
  const words = [];
  for (let at = 0; at < bits.length; at += 11) words.push(BIP39_ENGLISH[parseInt(bits.slice(at, at + 11), 2)]);
  return { ok: true, words, phrase: words.join(' ') };
}

/**
 * 24 WORDS -> 32 BYTES, or a refusal that says why.
 *
 * A word outside the list, a wrong count, or a checksum that does not match are each a refusal. None of
 * them returns bytes: a phrase that does not check is not a seed.
 */
export function seedFromPhrase(phrase) {
  const words = (Array.isArray(phrase) ? phrase : String(phrase || '').trim().toLowerCase().split(/\s+/))
    .map((w) => String(w).trim().toLowerCase()).filter(Boolean);
  if (words.length !== PHRASE_WORDS)
    return { ok: false, why: `a phrase is ${PHRASE_WORDS} words and that is ${words.length}` };
  let bits = '';
  for (const [i, w] of words.entries()) {
    const at = INDEX_OF.get(w);
    if (at === undefined) return { ok: false, why: `word ${i + 1}, "${w}", is not in the wordlist`, wrongAt: i };
    bits += at.toString(2).padStart(11, '0');
  }
  const seed = new Uint8Array(ENTROPY_BYTES);
  for (let i = 0; i < ENTROPY_BYTES; i++) seed[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  if (bits.slice(ENTROPY_BYTES * 8) !== checksumBits(seed))
    return { ok: false, why: 'that phrase does not check out - one of the words is wrong' };
  return { ok: true, seed };
}

/**
 * WHAT THE PLAYER TYPED, AS THE 64 HEX importSeed TAKES (2026-10-04): the 24 words of his backup -
 * checked, so a wrong word is refused by name and never restores an empty wallet - or the 64 hex digits as before.
 * The words encode the 32-byte seed directly (no BIP-39 key stretching: the keys stay this game's own hash of the
 * seed), so they restore this game's wallet and nothing else. Answers { ok, hex, from: 'words' | 'hex' } or { ok:false, why }.
 */
export function seedHexFromInput(text) {
  const t = String(text == null ? '' : text).trim();
  if (/^[0-9a-fA-F]{64}$/.test(t)) return { ok: true, hex: t.toLowerCase(), from: 'hex' };
  const got = seedFromPhrase(t);
  if (!got.ok) return { ok: false, why: `${got.why} (24 words, or the 64 hex digits)` };
  let hex = '';
  for (const b of got.seed) hex += b.toString(16).padStart(2, '0');
  return { ok: true, hex, from: 'words' };
}
