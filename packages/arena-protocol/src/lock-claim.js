// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE PLAYER'S CLAIM ON THE LOCKS ITS ENTRY NAMES (kanban #1489, #1897, #1938).
//
// An entry carries no player signature and a lock is not bound to its entry id, so anyone who saw a player's entry could post a
// copy under a session key of his own (same player key, same stake point, same lock outpoints): the copy passes lockMatchesEntry
// field by field, and "the entry that named the lock first" was the only thing a seat could go by. "First" is a seat's own
// clock - two honest seats 1.5 s apart, or one dishonest seat that backdates the copy, handed the player's lock to the copy.
//
// A CLAIM is what only the player can make: a BIP-340 signature over claimDigest(entry id) by the entry's STAKE POINT P - the
// stake preimage p (P = p.G, the handout's constant commitment A0) is the player's alone; a copier never holds it, and the
// signature reveals nothing of p. The entry id commits to the stake point and to both lock outpoints, so one claim binds this
// entry to its stake lock and its fee lock, and to no other entry: a copy under another session key has another id, and the
// player's claim does not verify for it.
//
// Additive: no encoding, no entry and no lock rule changes. A seat that holds a claim for an entry naming a lock outpoint hands
// that lock only to a claimed entry (stake-lock-signer-node.js); without any claim the old rule stands.
import { taggedHash } from './hash.js';

export const LOCK_CLAIM_TAG = 'ARENA/v1/LockClaim';
export const LOCK_CLAIM_BYTES = 64;

/** The 32 bytes a lock claim signs: the tagged hash of the entry id. */
export function lockClaimDigest(entryIdBytes) {
  if (!(entryIdBytes instanceof Uint8Array) || entryIdBytes.length !== 32) throw new Error('a lock claim is made for a 32-byte entry id');
  return taggedHash(LOCK_CLAIM_TAG, entryIdBytes);
}

/** The x-only key a claim verifies under: the entry's 33-byte stake point less its parity byte, or null for an entry with none. */
export function lockClaimKeyOf(entry) {
  const p = entry && entry.stakePoint;
  if (!(p instanceof Uint8Array) || p.length !== 33 || (p[0] !== 2 && p[0] !== 3)) return null;
  return p.subarray(1);
}
