// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AN APP'S DONATION SPLIT, CHANGED BY ITS DEVELOPER (kanban #582, 2026-10-22: "die Game dev splits darf nur dann gelten, wenn der
// game dev eingeloggt ist"): an app names its developers' split in its signed manifest (gameDonationSetId), so a new split is the app's
// next version - the same body, version + 1, the version it replaces as its parent, the new set's id - signed with the app's developer
// key. That key stays with its developer: the owner page signs in the developer's browser, a node only checks and hosts the signed
// version (plugin-check.js: same developer, its parent, a higher version). Isomorphic: the owner page bundles it, the node's tests run it.
import { ed25519 } from '@noble/curves/ed25519.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { manifestBodyId, encodeManifest, gameIdOf, manifestStands } from '../../arena-protocol/src/manifest.js';
import { donationSetId, donationSetStands } from '../../arena-protocol/src/donation.js';
import { gameInfoDigest, gameInfoJson } from '../../arena-protocol/src/game-info.js';

const verify = (sig, msg, key) => { try { return ed25519.verify(sig, msg, key); } catch { return false; } };
const PKCS8_ED25519 = '302e020100300506032b657004220420';

/**
 * A DEVELOPER KEY AS ITS DEVELOPER HAS IT: an Ed25519 PKCS#8 file (PEM, or its DER in base64 or hex, as arena-donor's game-dev.pkcs8),
 * or the 32-byte seed in hex. Answers { ok, seed, pubkey (hex) } or { ok: false, why }.
 */
export function devKeyFromText(text) {
  const t = String(text || '').trim();
  let der = null;
  if (/^[0-9a-f]{64}$/i.test(t)) { const seed = fromHex(t.toLowerCase()); return { ok: true, seed, pubkey: toHex(ed25519.getPublicKey(seed)) }; }
  try {
    if (/^[0-9a-f]+$/i.test(t) && t.length % 2 === 0) der = fromHex(t.toLowerCase());
    else {
      const b64 = t.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
      der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    }
  } catch { der = null; }
  if (!der || der.length !== 48 || toHex(der.subarray(0, 16)) !== PKCS8_ED25519) return { ok: false, why: 'that is no Ed25519 developer key (a PKCS#8 file, or the 32-byte seed in hex)' };
  const seed = der.slice(16);
  return { ok: true, seed, pubkey: toHex(ed25519.getPublicKey(seed)) };
}

/** The split as the page has it ([{ key, label, shareBps }]) as a donation set, or why it is none. */
export function splitAsSet(recipients) {
  let set;
  try { set = (recipients || []).map((r) => ({ recipientPk: fromHex(String(r.key || '').toLowerCase()), shareBps: Number(r.shareBps), label: String(r.label || '') })); }
  catch { return { ok: false, why: 'every developer is named by a 33-byte key in hex' }; }
  const s = donationSetStands(set);
  return s.ok ? { ok: true, set } : { ok: false, why: s.why };
}

/**
 * THE APP'S NEXT VERSION WITH A NEW SPLIT: `game` { manifest, info } (the version it replaces), `set` the new donation set, `seed` the
 * developer key's seed. Answers { manifest, hex, gameId, donationSet (JSON), info (signed again for the new id, or null) }.
 */
export function nextVersionWithSplit(game, set, seed) {
  const old = game.manifest;
  if (toHex(ed25519.getPublicKey(seed)) !== toHex(old.gameDevPubkey)) throw new Error('that key is not this app\'s developer key');
  const { signature: _s, ...body0 } = old;
  const body = { ...body0, version: old.version + 1, parentManifestId: gameIdOf(old), gameDonationSetId: donationSetId(set) };
  const manifest = { ...body, signature: ed25519.sign(manifestBodyId(body), seed) };
  const stands = manifestStands(manifest, { verify, parentOf: (id) => (toHex(id) === toHex(gameIdOf(old)) ? old : null) });
  if (!stands.ok) throw new Error(`the new version does not stand: ${stands.why}`);
  const gameId = gameIdOf(manifest);
  // ITS DESCRIPTION, signed again for the new id (a description is signed for one game id)
  let info = null;
  if (game.info && (game.info.description || game.info.website)) {
    const i = { description: game.info.description || '', website: game.info.website || '', ...(game.info.lightning ? { lightning: game.info.lightning } : {}) };
    info = gameInfoJson({ ...i, signature: ed25519.sign(gameInfoDigest(gameId, i), seed) });
  }
  return { manifest, hex: toHex(encodeManifest(manifest)), gameId: toHex(gameId),
    donationSet: set.map((r) => ({ recipientPk: toHex(r.recipientPk), shareBps: Number(r.shareBps), label: r.label || '' })), info };
}
