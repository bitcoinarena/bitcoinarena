// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A /play SOCKET SHOWN TO BE THE PLAYER'S (kanban #3742, ruled 2026-11-25). Every player-signed byte a /play socket carries -
// the first mark, the marks after it, the signed batches - is public (GET /entry-void, /checkpoints, /batch-signatures), so a
// socket that sent them has shown nothing about who it is. What a stranger cannot replay is a signature made for this one socket:
// the seat draws a nonce for the socket (`nonce` -> `nonce <hex>`), and the entry's session key - the key its marks and batches are
// already signed with - signs the digest below (`player <entry hex> <signature hex>` -> `player <entry hex>`). The seat's own key is
// in the digest, so a signature shown to one seat is no use at another.
import { taggedHash } from './hash.js';
import { TAG } from './constants.js';

export const PLAY_OWNER_NONCE_BYTES = 32;

const is32 = (b) => b instanceof Uint8Array && b.length === 32;

/** The digest the entry's session key signs to bind one /play socket at one seat to the entry. */
export function playOwnerDigest({ seatPubkey, nonce, entryId }) {
  if (!is32(seatPubkey)) throw new Error('a play-owner digest names the seat by its 32-byte key');
  if (!(nonce instanceof Uint8Array) || nonce.length !== PLAY_OWNER_NONCE_BYTES) throw new Error(`a play-owner nonce is ${PLAY_OWNER_NONCE_BYTES} bytes`);
  if (!is32(entryId)) throw new Error('a play-owner digest names a 32-byte entry id');
  const msg = new Uint8Array(32 + PLAY_OWNER_NONCE_BYTES + 32);
  msg.set(seatPubkey, 0); msg.set(nonce, 32); msg.set(entryId, 32 + PLAY_OWNER_NONCE_BYTES);
  return taggedHash(TAG.playSocketOwner, msg);
}
