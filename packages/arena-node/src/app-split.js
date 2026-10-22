// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AN APP'S DONATION SPLIT, CHANGED FROM THE OWNER PAGE (kanban #578, the owner 2026-10-22: "What I don't see yet is changing the percentages
// of games and markets", ruling A): an app names its developers' split in its signed manifest (gameDonationSetId), so a new split is the
// app's next version - the same body, version + 1, the version it replaces as its parent, the new set's id - signed with the app's
// developer key. The node holds the developer keys it may sign with as Ed25519 PKCS#8 files in one folder (ARENA_APP_KEYS_DIR, else
// <database>.app-keys); a key is used only for an app whose manifest names it. The new version stands like any update (plugin-check.js
// checkUpdate: same developer, its parent, a higher version), so nodes that update automatically take it.
import { createPrivateKey } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { manifestBodyId, encodeManifest, gameIdOf, manifestStands } from '../../arena-protocol/src/manifest.js';
import { donationSetId, donationSetStands } from '../../arena-protocol/src/donation.js';
import { gameInfoDigest, gameInfoJson } from '../../arena-protocol/src/game-info.js';

const verify = (sig, msg, key) => { try { return ed25519.verify(sig, msg, key); } catch { return false; } };

/** THE DEVELOPER KEYS IN A FOLDER: Map(public key hex -> 32-byte Ed25519 seed), from every *.pkcs8 file (DER or PEM) it can read. */
export function appKeysIn(dir) {
  const keys = new Map();
  if (!dir || !existsSync(dir)) return keys;
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.pkcs8'))) {
    try {
      const raw = readFileSync(join(dir, f));
      const k = createPrivateKey(raw.toString('latin1').includes('BEGIN') ? raw : { key: raw, format: 'der', type: 'pkcs8' });
      if (k.asymmetricKeyType !== 'ed25519') continue;
      const seed = new Uint8Array(Buffer.from(k.export({ format: 'jwk' }).d, 'base64url'));
      keys.set(toHex(ed25519.getPublicKey(seed)), seed);
    } catch { /* not a key this node can read */ }
  }
  return keys;
}

/** The split as the page sends it ([{ key, label, shareBps }]) as a donation set, or why it is none. */
export function splitAsSet(recipients) {
  let set;
  try { set = (recipients || []).map((r) => ({ recipientPk: fromHex(String(r.key || '').toLowerCase()), shareBps: Number(r.shareBps), label: String(r.label || '') })); }
  catch { return { ok: false, why: 'every developer is named by a 33-byte key in hex' }; }
  const s = donationSetStands(set);
  return s.ok ? { ok: true, set } : { ok: false, why: s.why };
}

/**
 * THE APP'S NEXT VERSION WITH A NEW SPLIT: `game` a hosted entry ({ manifest, donationSet, info }), `set` the new donation set, `seed`
 * the developer key's seed. Answers { manifest, gameId, donationSet (JSON), info (re-signed for the new id, or null) }.
 */
export function nextVersionWithSplit(game, set, seed) {
  const old = game.manifest;
  const pub = ed25519.getPublicKey(seed);
  if (toHex(pub) !== toHex(old.gameDevPubkey)) throw new Error('that key is not this app\'s developer key');
  const { signature: _s, ...body0 } = old;
  const body = { ...body0, version: old.version + 1, parentManifestId: gameIdOf(old), gameDonationSetId: donationSetId(set) };
  const manifest = { ...body, signature: ed25519.sign(manifestBodyId(body), seed) };
  const stands = manifestStands(manifest, { verify, parentOf: (id) => (toHex(id) === toHex(gameIdOf(old)) ? old : null) });
  if (!stands.ok) throw new Error(`the new version does not stand: ${stands.why}`);
  encodeManifest(manifest);
  const gameId = gameIdOf(manifest);
  // ITS DESCRIPTION, signed again for the new id (a description is signed for one game id)
  let info = null;
  if (game.info && (game.info.description || game.info.website)) {
    const i = { description: game.info.description || '', website: game.info.website || '', ...(game.info.lightning ? { lightning: game.info.lightning } : {}) };
    info = gameInfoJson({ ...i, signature: ed25519.sign(gameInfoDigest(gameId, i), seed) });
  }
  return { manifest, gameId: toHex(gameId),
    donationSet: set.map((r) => ({ recipientPk: toHex(r.recipientPk), shareBps: Number(r.shareBps), label: r.label || '' })), info };
}
