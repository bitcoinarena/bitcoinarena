// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE PLAYER'S KEY COMES FROM THE PLAYER'S SEED, AND THE PLAYER CAN CHECK IT.
//
// Section 24 (v4.6.2, F2): "Under the stake lock the money returns to
// `refund_pk`, a key the client builds the lock with - not to the wallet that
// paid. A lying client would set it to an attacker's key and the wallet would
// show only a deposit. Therefore `player_pubkey` is derived from a PLAYER SEED
// the player holds and backs up, FRESH PER ROUND (so locks are not linkable
// across rounds), and the client shows its FINGERPRINT where the player can
// compare it outside the page." The payout of a qualifier goes to the same key.
//
// THE RULE, ALL OF IT:
//
//   secret      = the first taggedHash("ARENA/v1/PlayerKey", seed || round_id || c),
//                 c = 0, 1, ..., that is a scalar of the group (0 < s < n)
//   order n > 0 = the same over seed || round_id || n (4 bytes, big-endian) || c: one key per ORDER a tab places
//                 in a market round - each order is its own entry, lock, payout and return, as the
//                 seats hold it; order 0 is the round's key above, byte for byte
//   player key  = x-only(secret . G)                      (BIP-340)
//   refund key  = 0x02 || player key                      (stake-lock.js)
//   fingerprint = the first 8 bytes of
//                 taggedHash("ARENA/v1/RefundFingerprint", refund key),
//                 as four groups of four hex digits
//
// Nothing in it needs the page: a player with the seed and the round id can
// run it anywhere (`arena-node/tools/refund-key.mjs` is one such place) and
// compare the fingerprint the page shows. The spec names the rule's parts and
// not the hash; this is the smallest thing that meets them, in the tagged-hash
// form every other derivation here uses. The curve is injected, as always.
import { taggedHash, toHex } from './hash.js';
import { FIELD, scalarFrom32 } from './shares.js';
import { TAG } from './constants.js';
import { refundKeyOf } from './stake-lock.js';

export const PLAYER_SEED_BYTES = 32;

const isPlayerBytes32 = (b) => b instanceof Uint8Array && b.length === 32;

/** This round's player secret from the player's seed - and an order's, for order n > 0. */
export function playerSecretFor(seed, roundId, order = 0) {
  if (!isPlayerBytes32(seed)) throw new Error('a player seed is 32 bytes');
  if (!isPlayerBytes32(roundId)) throw new Error('a round id is 32 bytes');
  if (!Number.isInteger(order) || order < 0 || order > 0xffffffff) throw new Error('an order number is a whole number from 0 to 2^32 - 1');
  const at = order ? 68 : 64;
  const msg = new Uint8Array(at + 1);
  msg.set(seed, 0);
  msg.set(roundId, 32);
  if (order) new DataView(msg.buffer).setUint32(64, order, false);
  for (let c = 0; c < 256; c++) {
    msg[at] = c;
    const secret = taggedHash(TAG.playerKey, msg);
    const v = scalarFrom32(secret);
    if (v > 0n && v < FIELD) return secret;
  }
  throw new Error('no scalar of the group in 256 tries, which should not happen');
}

/**
 * THE TAB'S LOBBY IDENTITY SECRET (M3.3-34), from the same seed as every round's
 * player key and under its own tag: it is never a round's key, it pays and
 * refunds nothing, and the seed backup the page shows backs it up too.
 */
export function identitySecretFor(seed) {
  if (!isPlayerBytes32(seed)) throw new Error('a player seed is 32 bytes');
  const msg = new Uint8Array(33);
  msg.set(seed, 0);
  for (let c = 0; c < 256; c++) {
    msg[32] = c;
    const secret = taggedHash(TAG.lobbyIdentity, msg);
    const v = scalarFrom32(secret);
    if (v > 0n && v < FIELD) return secret;
  }
  throw new Error('no scalar of the group in 256 tries, which should not happen');
}

/** What the player compares outside the page: 64 bits of the refund key's hash. */
export function refundFingerprint(playerPubkey) {
  if (!isPlayerBytes32(playerPubkey)) throw new Error('a player key is 32 bytes');
  const h = taggedHash(TAG.refundFingerprint, refundKeyOf(playerPubkey));
  return toHex(h.subarray(0, 8)).match(/.{4}/g).join('-');
}

/** Is this the key that seed makes for this round? Only the seed's holder can ask. */
export function playerKeyIsDerived({ seed, roundId, playerPubkey, curve } = {}) {
  if (!curve || typeof curve.pointX !== 'function')
    return { ok: false, why: 'deriving a player key needs a curve, and none was injected' };
  if (!isPlayerBytes32(playerPubkey)) return { ok: false, why: 'that is not a 32-byte player key' };
  let want;
  try { want = curve.pointX(playerSecretFor(seed, roundId)); } catch (e) { return { ok: false, why: e.message }; }
  if (toHex(want) !== toHex(playerPubkey))
    return {
      ok: false,
      why: 'that player key is not the one this seed makes for this round: a payout or refund '
        + 'to it reaches a key the player cannot check',
    };
  return { ok: true, fingerprint: refundFingerprint(playerPubkey) };
}

/**
 * THE KEY A PLAYER OWNS IN-GAME ITEMS WITH (ruling 2): from the same seed, under its own tag, and the SAME in every
 * round - an item is bought once and kept, while a round's player key is fresh per round (so locks stay unlinkable). It signs the
 * purchase (purchase.js) and, on an entry that plays with the item, the proof that this entry's per-round key is its owner's
 * (contracts.js entryItemDigest). It never holds a stake and nothing is refunded to it.
 */
export function itemsSecretFor(seed) {
  if (!isPlayerBytes32(seed)) throw new Error('a player seed is 32 bytes');
  const msg = new Uint8Array(33);
  msg.set(seed, 0);
  for (let c = 0; c < 256; c++) {
    msg[32] = c;
    const secret = taggedHash(TAG.itemsKey, msg);
    const v = scalarFrom32(secret);
    if (v > 0n && v < FIELD) return secret;
  }
  throw new Error('no scalar of the group in 256 tries, which should not happen');
}
