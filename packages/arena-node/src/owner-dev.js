// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// SIGN NEW GAMES AND MARKETS IN THE OWNER AREA (2026-10-09: "Sign new games and markets"): the
// owner's developer key is an Ed25519 key derived from the owner's 24 words under its own tag (never the owner key itself,
// which signs owner requests with BIP-340), and a manifest is signed in the page exactly as `arena-donor sign` signs it:
// the body's id (manifestBodyId), Ed25519 - deterministic, so the same body and key give the same bytes in both.
// Isomorphic: the owner page bundles it (owner-entry.js), the node's tests run it.
import { ed25519 } from '@noble/curves/ed25519.js';
import { taggedHash, toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { manifestBodyId, encodeManifest, decodeManifest, gameIdOf, manifestStands, RESULT_TYPE, PAYOUT_RULE } from '../../arena-protocol/src/manifest.js';

export const OWNER_DEV_KEY_TAG = 'arena/node-owner/dev-key/v1';
/** The 32-byte Ed25519 secret seed of the owner's developer key, from the 32 bytes behind the 24 words. */
export const devSeedFromSeed = (seed) => taggedHash(OWNER_DEV_KEY_TAG, seed);
export const devPubkeyOf = (devSeed) => ed25519.getPublicKey(devSeed);

// A MANIFEST BODY AS JSON, typed by field (not guessed): 32-byte values in hex, BigInt values as decimal strings, the result
// type and payout rule by name or number
const BYTES = ['gameDevPubkey', 'parentManifestId', 'gameDonationSetId'];
const BYTES_LISTS = ['clients', 'attestors'];
const BIGINTS = ['roundPeriodMs', 'revealWindowMs'];
const TERM_BIGINTS = ['resolveAfterCloseMs', 'deadlineAfterResolveMs'];
const b32 = (v, what) => { const h = String(v || '').toLowerCase(); if (!/^[0-9a-f]{64}$/.test(h)) throw new Error(`${what} is 32 bytes in hex`); return fromHex(h); };
const big = (v, what) => { if (!/^\d+$/.test(String(v))) throw new Error(`${what} is a whole number`); return BigInt(String(v)); };
const named = (v, table, what) => { if (typeof v === 'number') return v; if (v in table) return table[v]; throw new Error(`${what} ${v} is not one of ${Object.keys(table).join(', ')}`); };

export function bodyFromJson(json, { devPubkey } = {}) {
  const j = typeof json === 'string' ? JSON.parse(json) : json;
  const m = { ...j };
  // the developer key is the owner's: filled in when the body leaves it out, refused when it names another
  if (devPubkey && (m.gameDevPubkey === undefined || m.gameDevPubkey === null || m.gameDevPubkey === '')) m.gameDevPubkey = toHex(devPubkey);
  if (m.parentManifestId === undefined) m.parentManifestId = '00'.repeat(32);
  for (const k of BYTES) if (m[k] !== undefined) m[k] = b32(m[k], k);
  for (const k of BYTES_LISTS) if (Array.isArray(m[k])) m[k] = m[k].map((x, i) => b32(x, `${k}[${i}]`));
  for (const k of BIGINTS) if (m[k] !== undefined) m[k] = big(m[k], k);
  if (Array.isArray(m.cores)) m.cores = m.cores.map((c, i) => ({ hash: b32(c.hash, `cores[${i}].hash`), configs: (c.configs || []).map((x, n) => b32(x, `cores[${i}].configs[${n}]`)) }));
  if (m.marketTerms) { m.marketTerms = { ...m.marketTerms }; for (const k of TERM_BIGINTS) if (m.marketTerms[k] !== undefined) m.marketTerms[k] = big(m.marketTerms[k], `marketTerms.${k}`); }
  m.resultType = named(m.resultType, RESULT_TYPE, 'result type');
  m.payoutRule = named(m.payoutRule, PAYOUT_RULE, 'payout rule');
  // the lists a manifest keeps sorted
  for (const k of BYTES_LISTS) if (Array.isArray(m[k])) m[k] = [...m[k]].sort((x, y) => (toHex(x) < toHex(y) ? -1 : toHex(x) > toHex(y) ? 1 : 0));
  return m;
}

/**
 * THE SIGNED MANIFEST, as arena-donor's signManifest makes it: the body must name this developer key; the signature over
 * its id is checked before it is handed back, and the whole manifest must stand as a node checks it (manifestStands).
 * Answers { manifest, hex, gameId } or throws by name.
 */
export function signManifestWithSeed(body, devSeed) {
  const pubkey = devPubkeyOf(devSeed);
  if (!(body.gameDevPubkey instanceof Uint8Array) || toHex(body.gameDevPubkey) !== toHex(pubkey))
    throw new Error('that manifest names another developer key than this owner\'s');
  const digest = manifestBodyId(body);
  const signature = ed25519.sign(digest, devSeed);
  if (!ed25519.verify(signature, digest, pubkey)) throw new Error('the signature does not verify');
  const manifest = { ...body, signature };
  const stands = manifestStands(manifest, { verify: (sig, msg, key) => { try { return ed25519.verify(sig, msg, key); } catch { return false; } } });
  if (!stands.ok) throw new Error(`the manifest does not stand: ${stands.why}`);
  const bytes = encodeManifest(manifest);
  decodeManifest(bytes);
  return { manifest, hex: toHex(bytes), gameId: toHex(gameIdOf(manifest)) };
}
