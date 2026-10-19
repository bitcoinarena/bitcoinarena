// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE NODE'S SEED, WRITTEN DOWN AND ASKED BACK (-C.6; 2026-10-18: "prompts the user to setup his node keys or
// Nostr so he can authenticate in the future and prompts the user to write down his seed").
//
// 32 random bytes, shown as the 24 BIP-39 words the owner page already uses (arena-client/src/bip39.js), so the same words log in at
// /Dashboard/owner in any browser: the owner key is ownerSecretFromSeed(seed), exactly as the page derives it (arena-node/src/owner.js).
// The wizard does not go on until the user has typed back CONFIRM_WORDS words it picks at random - a phrase never written down is
// a phrase lost.
import { randomBytes, randomInt } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { phraseFromSeed, seedFromPhrase } from '../../arena-client/src/bip39.js';
import { ownerSecretFromSeed } from '../../arena-node/src/owner.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { emergencyCodeBytes, emergencyCodeText, emergencySecret } from '../../arena-protocol/src/emergency.js';

export const CONFIRM_WORDS = 3;

/** A new seed: { seed (32 bytes), words (24) }. */
export function newSeed(rand = randomBytes) {
  const seed = new Uint8Array(rand(32));
  return { seed, words: phraseFromSeed(seed).words };
}

/** The positions (1-based, ascending) the user is asked for. */
export function confirmPositions(n = CONFIRM_WORDS, pick = randomInt) {
  const got = new Set();
  while (got.size < n) got.add(pick(1, 25));
  return [...got].sort((a, b) => a - b);
}

/** Did the user type the right words at those positions? Case and spaces do not count. Answers { ok, wrong: [positions] }. */
export function checkConfirm(words, positions, answers) {
  const wrong = positions.filter((p) => String((answers || {})[p] || '').trim().toLowerCase() !== words[p - 1]);
  return { ok: wrong.length === 0, wrong };
}

/** The owner key pair the 24 words give, as the owner page derives it: { secret, pubkey (x-only hex) }. */
export function ownerKeyOf(seed) {
  const secret = ownerSecretFromSeed(seed);
  return { secret, pubkey: toHex(schnorr.getPublicKey(secret)) };
}

/**
 * THE OWNER'S EMERGENCY CODE (spec §23A.5a, protocol 17): derived from the same 24 words on its own path, written down beside them, and
 * typed at any other node's page or the Arena site to take this node out of the network while it is offline - it can do nothing else.
 * Never stored: the installer shows it from the seed. { code: 'ARN-XXXX-...', pubkey (x-only hex, the one the bond advert names) }.
 */
export function emergencyOf(seed) {
  const bytes = emergencyCodeBytes(seed);
  return { code: emergencyCodeText(bytes), pubkey: toHex(schnorr.getPublicKey(emergencySecret(bytes))) };
}

/** A typed phrase back to its seed (restore): { ok, seed } or { ok: false, why } - a wrong word or checksum is refused by name. */
export const seedOfWords = (words) => seedFromPhrase(words);

// A NOSTR OWNER (owner.js): the owner key is the Nostr key, both BIP-340. An npub or 64 hex characters.
const BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
/** An npub (bech32, NIP-19) or a 64-hex x-only key -> 64 hex; null when it is neither. */
export function nostrPubkeyHex(text) {
  const t = String(text || '').trim().toLowerCase();
  if (/^[0-9a-f]{64}$/.test(t)) return t;
  const m = /^npub1([qpzry9x8gf2tvdw0s3jn54khce6mua7l]+)$/.exec(t);
  if (!m) return null;
  const data = [...m[1]].map((c) => BECH32.indexOf(c));
  if (!bech32Valid('npub', data)) return null;
  const bits = []; for (const v of data.slice(0, -6)) for (let i = 4; i >= 0; i--) bits.push((v >> i) & 1);
  const bytes = []; for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  return bytes.length === 32 ? Buffer.from(bytes).toString('hex') : null;
}
function bech32Valid(hrp, data) {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  const values = [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31), ...data];
  for (const v of values) { const top = chk >> 25; chk = ((chk & 0x1ffffff) << 5) ^ v; for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= G[i]; }
  return chk === 1;
}
