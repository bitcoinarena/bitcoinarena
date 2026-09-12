// A SEAT VERIFIES THE PLAYER'S STAKE LOCK (v4.6.2 §23.1 step 5).
//
// "STAKE_COMMITTED is recorded once >=5 settlement nodes have VERIFIED the
// locks: the contract id at stake_lock_outpoint (and the fee lock's) equals
// the hash of a contract whose payment_image is the entry's stake_point,
// whose amount is the entry's net stake, whose claim_pk is the attested key,
// whose refund_pk is player_pubkey, and whose expiration is >= current height
// + stake_expiry_blocks. Seeing the lock is not enough: the player built it."
//
// This is one seat's half. The player hands the seat the contract it locked;
// the seat asks the federation what it holds at the entry's outpoint (the
// stored contract id and the blocks left to its expiry), hashes the handed
// contract with the stock client's own rule, and requires the two to be one
// contract; then protocol stake-lock.js `lockMatchesEntry` checks every field
// against the entry. Only then is the stake seen - the same record the play
// gate reads, so a verified lock and a held HTLC open play the same way.
//
// THE FEDERATION IS A PORT, as Lightning is: `status(outpoint)` answers
// `{ blockCount, stored: { contractId, blocksLeft } | null }` and
// `contractId(fields)` the stock hash (blwp-stake-lock, over the Rust client
// crates). The fee lock is not checked here: its claim hash and the §22A node
// slots wait on a ruling (PRIORITIES).
import { decodeEntryContract, decodeRoundContract } from '../../protocol/src/contracts.js';
import { lockMatchesEntry } from '../../protocol/src/stake-lock.js';
import { toHex, fromHex } from '../../protocol/src/hash.js';

const zero = (b) => !(b instanceof Uint8Array) || b.every((x) => x === 0);

/** The contract a player hands over, as JSON: hex bytes, amount as a decimal string. */
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

export async function verifyStakeLock({ round, port, entryIdBytes, fields, claimPk }) {
  const stored = round.entry(entryIdBytes);
  if (!stored) return { ok: false, why: 'this node seated no such entry' };
  const entry = decodeEntryContract(stored);
  if (entry.stakeMsat === 0n) return { ok: false, why: 'that entry takes no stake, so there is no lock to verify' };
  const row = round.get(entry.roundId);
  if (!row) return { ok: false, why: 'this node holds no such round' };
  const contract = decodeRoundContract(new Uint8Array(row.contract));
  if (contract.custody !== 'FEDERATION' || zero(contract.federationId))
    return { ok: false, why: 'that round names no federation, so its stake is not a lock' };
  if (!port) return { ok: false, why: 'this node reaches no federation, so it cannot verify a stake lock' };
  const outpoint = entry.stakeLockOutpoint;
  if (!outpoint || zero(outpoint.txid)) return { ok: false, why: 'that entry names no stake lock outpoint' };

  const st = await port.status(outpoint);
  if (!st || !st.stored) return { ok: false, why: 'the federation holds no lock at the entry\'s stake_lock_outpoint' };
  const id = await port.contractId(fields);
  if (String(id) !== String(st.stored.contractId))
    return { ok: false, why: 'the lock at that outpoint is not the contract handed over: its id is another' };
  if (fields.expiration !== st.blockCount + st.stored.blocksLeft)
    return { ok: false, why: 'that contract\'s expiration is not the one the federation holds' };
  if (!(claimPk instanceof Uint8Array)) return { ok: false, why: 'this seat holds no claim key for that round' };

  const matches = lockMatchesEntry({ lock: fields, entry, kind: 'stake', claimPk, height: st.blockCount });
  if (!matches.ok) return matches;

  round.putStakeLock({ entryId: entryIdBytes, roundId: entry.roundId, outpoint, fields: lockFieldsToJson(fields), contractId: String(id) });
  round.putStakeSeen({ entryId: entryIdBytes, paidMsat: fields.amountMsat });
  return { ok: true, contractId: String(id), paidMsat: fields.amountMsat, height: st.blockCount };
}
