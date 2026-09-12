// A SEAT CHECKS EVERY FIELD OF A LOCK BEFORE IT COUNTS A STAKE.
//
// Section 23.1 step 5 (v4.6.2, F4): "STAKE_COMMITTED is recorded once >=5
// settlement nodes have VERIFIED the locks: the contract id at
// stake_lock_outpoint (and the fee lock's) equals the hash of a contract whose
// payment_image is the entry's stake_point (resp. H(F)), whose amount is the
// entry's net stake (resp. fee), whose claim_pk is the attested key, whose
// refund_pk is player_pubkey, and whose expiration is >= current height +
// stake_expiry_blocks. Seeing the lock is not enough: the player built it, and
// a short expiry alone would let a loser refund before settlement."
//
// THE FIELDS, NOT THE ID. A contract id is Fedimint's hash of the whole
// contract (FEDERATION.md, audit point 8), and the seat's stock federation
// client answers `(contract_id, expiration)` for an outpoint. That client, not
// this package, hashes a contract the seat was handed and compares it with
// the id at the outpoint; what this checks is that the contract it hashed is
// the one the entry committed to, field by field, refused by name.
//
// AND F5: the fee lock's image is H(F), and F must never be the stake's P - a
// winner's fee lock is claimed too, and claiming it would publish the winner's
// P. With the stake a point and the fee a hash the images cannot collide; what
// can still be caught is F = P while the entry also carries H(P).
import { sha256, toHex, fromHex } from './hash.js';
import { netStakeMsat } from './payout.js';
import { STAKE_EXPIRY_BLOCKS } from './constants.js';

/**
 * THE CONTRACT A PLAYER HANDS A SEAT (POST /lock), as JSON: hex bytes, the
 * amount as a decimal string. Here, not in the node, because the page writes
 * it and the seat reads it - one encoding, not two that look alike.
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

export function lockMatchesEntry({ lock, entry, kind, claimPk, height } = {}) {
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
  if (!Number.isInteger(lock.expiration) || lock.expiration < height + STAKE_EXPIRY_BLOCKS)
    return {
      ok: false,
      why: `that ${kind} lock expires at ${lock.expiration}, before ${height} + ${STAKE_EXPIRY_BLOCKS}: `
        + 'a loser could refund before settlement',
    };
  return { ok: true };
}
