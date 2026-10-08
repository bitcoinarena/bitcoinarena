// WHAT THE LOCK CLIENT'S ANSWER MEANS FOR THE ENTRY AND THE SIGNER NODES (W1a).
//
// The lock client (lock-client/, the stock fedimint client crates built to
// wasm) funds one OutgoingContract and answers what the guardians stored at its
// outpoint beside what it computed. This turns that answer into the two things
// the round needs: the entry's stake_lock_outpoint (§7), and the contract a
// signer node is handed at POST /lock (§23.1 step 5). An answer whose stored contract
// is not the one computed, or whose stored expiry is not the computed one, is
// refused here - the player would otherwise commit to a lock that is not theirs.
// Not in the bundle yet: the page drives it in W1b.
import { fromHex } from '../../arena-protocol/src/hash.js';

// `point` for a stake lock (the stake point), or `hash` for a fee lock (H(F), Pick b).
export function lockFromClient(answer, { point, hash, claimPk, refundPk }) {
  if (!point === !hash) throw new Error('a lock is to a point or to a hash, and exactly one is named');
  const j = typeof answer === 'string' ? JSON.parse(answer) : answer;
  if (!j || typeof j.txid !== 'string' || !/^[0-9a-f]{64}$/.test(j.txid)) throw new Error('the lock client named no transaction');
  if (!Number.isInteger(j.out_idx) || j.out_idx < 0) throw new Error('the lock client named no output');
  if (j.ids_match !== true || j.stored_contract_id !== j.computed_contract_id)
    throw new Error('the guardians hold another contract at that outpoint than the one the lock client built');
  if (j.stored_expiration !== j.computed_expiration)
    throw new Error(`the guardians hold expiration ${j.stored_expiration}, and the lock client built ${j.computed_expiration}`);
  return {
    outpoint: { txid: fromHex(j.txid), outIdx: BigInt(j.out_idx) },
    fields: {
      paymentImage: point ? { kind: 'point', bytes: point } : { kind: 'hash', bytes: hash }, amountMsat: BigInt(j.amount_msat),
      claimPk, refundPk, expiration: j.computed_expiration,
    },
    contractId: j.stored_contract_id,
  };
}
