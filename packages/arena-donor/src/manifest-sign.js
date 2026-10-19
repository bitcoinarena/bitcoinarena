// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE DEV CLIENT SIGNS A GAME'S MANIFEST (2026-10-07 15:40: "the dev client is responsible for game
// signatures, not the node"). The game developer's Ed25519 key is held here, by the developer's own client, and signs the
// manifest body's id (arena-protocol/src/manifest.js manifestBodyId); what leaves is the public key, already in the body, and
// the 64-byte signature. A node only verifies (arena-node/src/plugins.js hostedPlugins): it never holds this key, never
// signs, and never makes a game by signing one itself.
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { manifestBodyId } from '../../arena-protocol/src/manifest.js';

/** The developer key from its PKCS#8 DER bytes, and its raw 32-byte public half. Refuses anything but Ed25519. */
export function gameDevKey(der) {
  const key = createPrivateKey({ key: Buffer.from(der), format: 'der', type: 'pkcs8' });
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('a game developer key is Ed25519');
  return { key, pubkey: new Uint8Array(createPublicKey(key).export({ type: 'spki', format: 'der' }).subarray(-32)) };
}

/**
 * THE SIGNED MANIFEST: `body` (its gameDevPubkey must be this key's) and the signature over its id, checked before it
 * is handed back - a key that is not the body's is refused, not signed with.
 */
export function signManifest(body, { key, pubkey }) {
  if (!(body.gameDevPubkey instanceof Uint8Array) || Buffer.compare(Buffer.from(body.gameDevPubkey), Buffer.from(pubkey)) !== 0)
    throw new Error('that manifest names another developer key than the one this client holds');
  const digest = Buffer.from(manifestBodyId(body));
  const signature = new Uint8Array(sign(null, digest, key));
  if (!verify(null, digest, createPublicKey(key), signature)) throw new Error('the signature does not verify');
  return { ...body, signature };
}
