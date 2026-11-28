// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// AN ENTRY PROVES ITS SESSION KEY AT THE DOOR (kanban #3824, RULED 2026-11-28, spec answer (a)). An entry travels with an entry proof: a signature
// by the entry's session key over tagged_hash("ARENA/v1/EntryProof", entry_id). POST /entry carries it, the seat-to-seat relay carries it
// unchanged, and a seat stores it with the entry. A seat refuses an entry without a valid proof (400) before any other check; it is never taken,
// never relayed, and never holds a session key. So only the owner of a session key can make an entry that names it, and the one-entry-per-session-key
// rule of #1479/#1597 only ever meets entries that key signed.
// The proof is an envelope beside the Entry Contract: the entry id, the commitment and every signed result are unchanged.
// The session key is the key the run's marks are signed with (Ed25519, round.js), so the proof is a signature of that key's scheme.
// Every round, free and paid, of every game; gated by the round's protocol version (ENTRY_PROOF_VERSION): a round of an earlier version is taken and
// relayed as before, so a mixed committee agrees per round. Old seats ignore the extra header.
import { taggedHash } from './hash.js';

export const ENTRY_PROOF_VERSION = 37;
export const ENTRY_PROOF_TAG = 'ARENA/v1/EntryProof';
/** The header POST /entry, the relay and GET /entry carry the proof in: 64 bytes as hex. */
export const ENTRY_PROOF_HEADER = 'x-arena-entry-proof';

/** Does this round require the proof? By the round's own version, never the seat's. */
export const requiresEntryProof = (contract) => !!contract && Number.isInteger(contract.protocolVersion) && contract.protocolVersion >= ENTRY_PROOF_VERSION;

/** What the session key signs: tagged_hash("ARENA/v1/EntryProof", entry_id). */
export const entryProofDigest = (entryId) => {
  if (!(entryId instanceof Uint8Array) || entryId.length !== 32) throw new Error('an entry id is 32 bytes');
  return taggedHash(ENTRY_PROOF_TAG, entryId);
};

/** Is `proof` (64 bytes) the session key's signature over this entry id? `verify(sig, msg, pubkey)` is the session scheme's (Ed25519; the curve is
 *  injected, as everywhere in this package). Never throws. */
export function entryProofHolds({ entryId, sessionPubkey, proof, verify }) {
  if (!(proof instanceof Uint8Array) || proof.length !== 64) return false;
  if (!(sessionPubkey instanceof Uint8Array) || sessionPubkey.length !== 32) return false;
  try { return !!verify(proof, entryProofDigest(entryId), sessionPubkey); } catch { return false; }
}

/** A header value (hex) as 64 bytes, or null. */
export function entryProofFromHeader(value) {
  const s = String(Array.isArray(value) ? value[0] : (value || '')).trim().toLowerCase();
  if (!/^[0-9a-f]{128}$/.test(s)) return null;
  const out = new Uint8Array(64);
  for (let i = 0; i < 64; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
}
