// A ROUND'S CREATOR (§6 `creator_pubkey` / `creator_signature`, kanban #313; 2026.0.3). A contract may name the x-only key of whoever
// created it (contracts.js CREATOR_MARKER); the creator's BIP-340 signature over the round's id rides beside the contract, as the id
// itself does - a signature cannot be inside the bytes it signs. "The creator gains no administrative power after publication - and
// no influence over the committee either": the key says WHO published the round (whom a publication fee is paid back to, #304),
// and nothing else. A contract that names no creator needs no signature, and none is asked of it.
//
// No curve here: the verifier is the caller's (the seat's noble schnorr, the page's BLWP_CURVE), as for every signed record.
import { taggedHash } from './hash.js';
import { TAG } from './constants.js';
import { roundId } from './contracts.js';

/** What the creator signs: the round's id under its own tag. */
export const creatorMessage = (roundIdBytes) => taggedHash(TAG.roundCreator, roundIdBytes);

/**
 * DOES THIS SIGNATURE STAND FOR THIS CONTRACT? `verify(sig, msg, xOnlyKey)` BIP-340. { ok, why }: a contract naming no creator
 * stands with none (and refuses one handed anyway - there is nobody it could be from); one naming a creator stands only with a
 * 64-byte signature by that key over its id.
 */
export function creatorSignatureStands(contract, signature, { verify }) {
  const named = contract && contract.creatorPubkey instanceof Uint8Array;
  if (!named) return signature ? { ok: false, why: 'that round names no creator, so no creator signature belongs to it' } : { ok: true, why: 'that round names no creator' };
  if (!(signature instanceof Uint8Array) || signature.length !== 64) return { ok: false, why: 'that round names its creator, and comes without the creator\'s 64-byte signature over its id' };
  let good = false;
  try { good = !!verify(signature, creatorMessage(roundId(contract)), contract.creatorPubkey); } catch { good = false; }
  return good ? { ok: true, why: 'signed by the creator the round names' } : { ok: false, why: 'that signature is not the named creator\'s over this round\'s id' };
}
