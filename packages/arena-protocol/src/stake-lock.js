// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A SIGNER NODE CHECKS EVERY FIELD OF A LOCK BEFORE IT COUNTS A STAKE.
//
// Section 23.1 step 5 (v4.6.2, F4): "STAKE_COMMITTED is recorded once >=5
// settlement nodes have VERIFIED the locks: the contract id at
// stake_lock_outpoint (and the fee lock's) equals the hash of a contract whose
// payment_image is the entry's stake_point (resp. H(F)), whose amount is the
// entry's net stake (resp. fee), whose claim_pk is the attested key, whose
// refund_pk is player_pubkey, and whose expiration is >= lock_height +
// stake_expiry_blocks, where lock_height is the federation's consensus height at
// which the transaction creating the lock was accepted ... and lock_height is no
// more than stake_lock_freshness_blocks (12) below the height at which the seat
// verifies. Seeing the lock is not enough: the player built it, and a short
// expiry alone would let a loser refund before settlement."
//
// THE LOCK'S OWN HEIGHT (RULED 2026-09-24, option (a)). The stock federation
// stores an outgoing contract with no creation height and answers only
// (contract_id, blocks_left), so lock_height is the federation-held expiration less
// stake_expiry_blocks - the expiration the signer node already checked against
// blockCount + blocksLeft, never the player's number. expiration >= lock_height + 144
// then holds by construction, and the check that bites is freshness: refused when
// expiration < verify height + 132. The old check, expiration >= verify height + 144,
// refused a lock built exactly as step 4 says one block later (450 against 316 + 144).
//
// THE FIELDS, NOT THE ID. A contract id is Fedimint's hash of the whole
// contract (FEDERATION.md, audit point 8), and the signer node's stock federation
// client answers `(contract_id, expiration)` for an outpoint. That client, not
// this package, hashes a contract the signer node was handed and compares it with
// the id at the outpoint; what this checks is that the contract it hashed is
// the one the entry committed to, field by field, refused by name.
//
// AND F5: the fee lock's image is H(F), and F must never be the stake's P - a
// winner's fee lock is claimed too, and claiming it would publish the winner's
// P. With the stake a point and the fee a hash the images cannot collide; what
// can still be caught is F = P while the entry also carries H(P).
import { sha256, toHex, fromHex } from './hash.js';
import { netStakeMsat } from './payout.js';
import { STAKE_EXPIRY_BLOCKS, STAKE_LOCK_FRESHNESS_BLOCKS } from './constants.js';

/**
 * THE CONTRACT A PLAYER HANDS A SIGNER NODE (POST /lock), as JSON: hex bytes, the
 * amount as a decimal string. Here, not in the node, because the page writes
 * it and the signer node reads it - one encoding, not two that look alike.
 */
export function lockFieldsFromJson(j) {
  if (!j || typeof j !== 'object') throw new Error('a stake lock is a JSON object');
  const img = j.paymentImage || {};
  if (img.kind !== 'point' && img.kind !== 'hash') throw new Error('a payment image is a point or a hash');
  const f = {
    paymentImage: { kind: img.kind, bytes: fromHex(String(img.bytes || '')) },
    amountMsat: BigInt(String(j.amountMsat)),
    claimPk: fromHex(String(j.claimPk || '')),
    refundPk: fromHex(String(j.refundPk || '')),
    expiration: Number(j.expiration),
  };
  if (!Number.isSafeInteger(f.expiration) || f.expiration < 0) throw new Error('an expiration is a block height');
  return f;
}

export const lockFieldsToJson = (f) => ({
  paymentImage: { kind: f.paymentImage.kind, bytes: toHex(f.paymentImage.bytes) },
  amountMsat: String(f.amountMsat), claimPk: toHex(f.claimPk), refundPk: toHex(f.refundPk), expiration: f.expiration,
});

const eq = (a, b) => a instanceof Uint8Array && b instanceof Uint8Array
  && a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * THE REFUND KEY AN ENTRY NAMES. `player_pubkey` is a BIP-340 x-only key; a
 * federation contract takes a compressed point, so it is the even-y one.
 */
export const refundKeyOf = (playerPubkey) => Uint8Array.from([0x02, ...playerPubkey]);

// `expiryBlocks`: the round's own stake_expiry_blocks (lock-expiry.js,: a market round's locks last its whole
// life; every other round the ruled 144) - the span its locks are made for, so a lock's height is its expiration less it
export function lockMatchesEntry({ lock, entry, kind, claimPk, height, expiryBlocks = STAKE_EXPIRY_BLOCKS } = {}) {
  if (kind !== 'stake' && kind !== 'fee') return { ok: false, why: 'a lock is a stake lock or a fee lock' };
  if (!lock || !entry) return { ok: false, why: 'there is no lock or no entry to compare' };
  if (!Number.isInteger(height) || height < 0)
    return { ok: false, why: 'there is no federation height, so nothing says the expiry is far enough' };

  const image = lock.paymentImage || {};
  if (kind === 'stake') {
    if (!(entry.stakePoint instanceof Uint8Array) || entry.stakePoint.every((b) => b === 0))
      return { ok: false, why: 'that entry names no stake point, so no stake lock can match it' };
    if (image.kind !== 'point' || !eq(image.bytes, entry.stakePoint))
      return { ok: false, why: 'that stake lock\'s payment image is not the entry\'s stake point' };
  } else {
    const hf = sha256(entry.feePreimage);
    if (image.kind !== 'hash' || !eq(image.bytes, hf))
      return { ok: false, why: 'that fee lock\'s payment image is not H(F) of the entry\'s fee preimage' };
    if (eq(hf, entry.stakeCommitment))
      return { ok: false, why: 'the fee preimage is the stake\'s own secret: claiming the fee would publish P (F5)' };
  }

  const want = kind === 'stake' ? netStakeMsat(entry) : entry.feeMsat;
  if (lock.amountMsat !== want)
    return {
      ok: false,
      why: `that ${kind} lock holds ${lock.amountMsat} msat, and the entry's `
        + `${kind === 'stake' ? 'net stake' : 'fee'} is ${want}`,
    };
  if (!eq(lock.claimPk, claimPk))
    return { ok: false, why: `that ${kind} lock's claim_pk is not this round's attested claim key` };
  if (!eq(lock.refundPk, refundKeyOf(entry.playerPubkey)))
    return { ok: false, why: `that ${kind} lock's refund_pk is not the entry's player key` };
  if (!Number.isInteger(lock.expiration)) return { ok: false, why: `that ${kind} lock names no expiration height` };
  if (!Number.isInteger(expiryBlocks) || expiryBlocks < 1) return { ok: false, why: 'the round names no stake_expiry_blocks to check the lock against' };
  const lockHeight = lock.expiration - expiryBlocks;
  if (lockHeight < height - STAKE_LOCK_FRESHNESS_BLOCKS)
    return {
      ok: false,
      why: `that ${kind} lock's lock height ${lockHeight} (its expiration ${lock.expiration} less the round's ${expiryBlocks} blocks) `
        + `is more than ${STAKE_LOCK_FRESHNESS_BLOCKS} blocks below the height ${height} it is verified at: `
        + 'a loser could refund before settlement',
    };
  return { ok: true };
}
