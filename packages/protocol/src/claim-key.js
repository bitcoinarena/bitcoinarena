// THE ROUND'S CLAIM KEY, AND WHY ONE SEAT'S WORD FOR IT IS NOT ENOUGH.
//
// Section 23.1 step 0 (v4.6.2): "Once selected, the settlement seats run a
// dealerless DKG for this round's threshold key `claim_pk` and each seat signs
// `(round_id, claim_pk)`. The key is valid only with signatures from >=5 seats
// (`claim_key_attestation_ref`); a client MUST refuse to lock to a key without
// them. Otherwise one seat could serve its own key and, after the shares are
// released, claim a loser's stake for itself." (F3)
//
// So there are two objects. One seat's attestation - what it signs. And the
// attested SET - one round, one key, the valid signatures sorted by seat - whose
// id an entry names, so the attestation a player locked under is pinned in
// the bytes they signed.
//
// "5" is the reference committee's threshold. The round's own is what counts
// (2 of 2 on a test net, 5 of 7 otherwise), read off its settlement slots the
// way every other threshold in this protocol is, never passed in by a caller.
// The curve is not this package's business: `verify(signature, digest, key)` is
// injected, as `authority.js` takes it.
import { Writer, Reader } from './encode.js';
import { taggedHash, toHex } from './hash.js';
import { PROTOCOL_VERSION, TYPE_CLAIM_KEY_ATTESTATION, TAG } from './constants.js';
import { receiptsNeeded } from './threshold.js';

/** A compressed secp256k1 point, as `groupKeyOf` computes the committee's key. */
export const CLAIM_KEY_BYTES = 33;
export const ATTESTATION_SIGNATURE_BYTES = 64;

const isClaimRound32 = (b) => b instanceof Uint8Array && b.length === 32;
const isClaimKeyPoint = (b) => b instanceof Uint8Array && b.length === CLAIM_KEY_BYTES && (b[0] === 0x02 || b[0] === 0x03);
const claimSeatOrder = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };

export function encodeClaimKeyAttestation(a) {
  const w = new Writer();
  w.u8(TYPE_CLAIM_KEY_ATTESTATION);
  w.u16(PROTOCOL_VERSION);
  w.bytes32(a.roundId);
  w.bytes(a.claimPk, CLAIM_KEY_BYTES);
  // WHO SAYS SO is in the signed bytes, so a signature cannot be moved from one
  // seat's record to another's.
  w.bytes32(a.seatPubkey);
  return w.finish();
}

export function decodeClaimKeyAttestation(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== TYPE_CLAIM_KEY_ATTESTATION) throw new Error('not a claim-key attestation');
  const version = r.u16();
  if (version !== PROTOCOL_VERSION) throw new Error('protocol version ' + version);
  const a = { roundId: r.bytes32(), claimPk: r.bytes(CLAIM_KEY_BYTES), seatPubkey: r.bytes32() };
  r.end();
  return a;
}

/** What one seat signs. */
export const claimKeyAttestationId = (a) =>
  taggedHash(TAG.claimKeyAttestation, encodeClaimKeyAttestation(a));

/**
 * THE ID AN ENTRY NAMES: the round, the key, and the signatures sorted by seat
 * key - asserted sorted, not sorted here, as every committed list is.
 */
export function claimKeyAttestationRef({ roundId, claimPk, signatures }) {
  const w = new Writer();
  w.bytes32(roundId);
  w.bytes(claimPk, CLAIM_KEY_BYTES);
  w.vec(signatures, (s, ww) => { ww.bytes32(s.seatPubkey); ww.bytes(s.signature, ATTESTATION_SIGNATURE_BYTES); },
    { sortedBy: (a, b) => claimSeatOrder(a.seatPubkey, b.seatPubkey) });
  return taggedHash(TAG.claimKeyAttestationSet, w.finish());
}

/**
 * IS THIS CLAIM KEY THE COMMITTEE'S? Counted over the round's SEATED
 * settlement committee - the roster's answer, not the contract's list - and
 * only once per seat: a signature from a key that is not seated, a second one
 * from the same seat, and one that does not verify all count for nothing.
 */
export function claimKeyIsAttested({ roundId, claimPk, signatures, seats, settlementSlots, verify } = {}) {
  if (!isClaimRound32(roundId)) return { ok: false, why: 'that attestation names no 32-byte round id' };
  if (!isClaimKeyPoint(claimPk)) return { ok: false, why: 'that claim key is not a 33-byte compressed point' };
  if (typeof verify !== 'function') return { ok: false, why: 'checking a claim key needs a verifier, and none was injected' };
  if (!Array.isArray(seats) || !seats.length)
    return { ok: false, why: 'this round has no seated settlement committee to attest a claim key' };
  let needed;
  try { needed = receiptsNeeded(settlementSlots); } catch (e) { return { ok: false, why: e.message }; }

  const seated = new Set(seats.map(toHex));
  const counted = new Map();
  for (const s of signatures || []) {
    if (!s || !isClaimRound32(s.seatPubkey) || !(s.signature instanceof Uint8Array)
      || s.signature.length !== ATTESTATION_SIGNATURE_BYTES) continue;
    const who = toHex(s.seatPubkey);
    if (!seated.has(who) || counted.has(who)) continue;
    const digest = claimKeyAttestationId({ roundId, claimPk, seatPubkey: s.seatPubkey });
    let good = false;
    try { good = !!verify(s.signature, digest, s.seatPubkey); } catch { good = false; }
    if (good) counted.set(who, s);
  }

  if (counted.size < needed)
    return {
      ok: false, attested: counted.size, needed,
      why: `${counted.size} of ${seats.length} seats attest this claim key, and this round needs ${needed}: `
        + 'a client does not lock a stake to it',
    };
  const valid = [...counted.values()].sort((a, b) => claimSeatOrder(a.seatPubkey, b.seatPubkey));
  return { ok: true, attested: counted.size, needed, ref: claimKeyAttestationRef({ roundId, claimPk, signatures: valid }) };
}
