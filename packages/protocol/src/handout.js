// THE SHARES A PLAYER PUBLISHED, AND THE POLYNOMIAL THEY WERE CUT FROM.
//
// 23.1 step 2: "The player splits P with verifiable secret sharing (Shamir,
// threshold 5-of-7) and encrypts one share to each settlement-committee
// member; `vss_shares_ref` points at the published shares." This is the object
// that reference points at.
//
// `shares.js` is the arithmetic - split, reconstruct, and the Feldman check
// that a share lies on the published polynomial. This is the wire: what a
// player hands the committee, what its id is, and what a seat asks before it
// accepts an entry. They are separate files because the maths has no business
// knowing a byte order and the wire has no business knowing a field.
//
// THE SHARES ARE IN THE CLEAR HERE AND THAT IS NOT SAFE FOR MONEY. 23.1 says
// "encrypts one share to each settlement-committee member", and this does not:
// anybody who reads a handout reads five shares and rebuilds P. In M2 that
// takes nothing, because M2 asks for no money and distributes none - there is
// no stake behind the preimage to steal. It becomes REQUIRED at the same
// moment the hold invoice does, it needs a key agreement nobody has chosen,
// and it is M3. A build that pays sats must not use this file as it stands.
//
// WHAT IT DOES BUY NOW: a dealer cannot hand out shares that no five seats can
// open. That property does not depend on the shares being secret, which is why
// it can be had first.
import { Writer, Reader } from './encode.js';
import { TAG, TYPE_VSS_HANDOUT, PROTOCOL_VERSION } from './constants.js';
import { taggedHash } from './hash.js';
import { checkHandout, FIELD, scalarFrom32, scalarTo32 } from './shares.js';

/** A commitment is a compressed point: 33 bytes, sign included. */
export const COMMITMENT_BYTES = 33;

export function encodeHandout(h) {
  const w = new Writer();
  w.u8(TYPE_VSS_HANDOUT);
  w.u16(PROTOCOL_VERSION);
  w.bytes32(h.roundId);
  w.bytes32(h.playerPubkey);
  // THE THRESHOLD IS ON THE OBJECT because a seat has to know how many
  // coefficients the commitments SHOULD be before it counts them: a dealer who
  // published four commitments for a threshold of five has published a
  // different polynomial, not a shorter list.
  w.u16(h.needed);
  w.vec(h.commitments, (c, ww) => ww.bytes(c, COMMITMENT_BYTES));
  // SORTED BY SEAT, asserted rather than sorted: the order is inside the id
  // the entry names, so a caller that shuffles must be refused and not
  // quietly corrected.
  w.vec(h.shares, (s, ww) => { ww.u16(s.seat); ww.bytes32(scalarTo32(s.value)); },
    { sortedBy: (a, b) => a.seat - b.seat });
  return w.finish();
}

export function decodeHandout(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== TYPE_VSS_HANDOUT) throw new Error('not a VssHandout');
  const version = r.u16();
  if (version !== PROTOCOL_VERSION) throw new Error('protocol version ' + version);
  const h = {
    roundId: r.bytes32(),
    playerPubkey: r.bytes32(),
    needed: r.u16(),
    commitments: r.vec((rr) => rr.bytes(COMMITMENT_BYTES)),
    shares: r.vec((rr) => ({ seat: rr.u16(), value: scalarFrom32(rr.bytes32()) })),
  };
  r.end();
  return h;
}

/**
 * The name an Entry Contract's `vss_shares_ref` carries.
 *
 * The tagged hash of the WHOLE handout, so the reference binds the shares and
 * the polynomial together: an entry names one handout and no other, and a
 * dealer cannot swap the polynomial under a reference that was already signed.
 */
export const handoutId = (h) => taggedHash(TAG.vssHandout, encodeHandout(h));

/** An entry that publishes no shares carries this, and it is not a handout. */
export const NO_SHARES = new Uint8Array(32);

/**
 * IS THIS HANDOUT ONE A SEAT CAN ACT ON?
 *
 * Shape first, then 23.1's own question. The shape checks are not ceremony:
 * a threshold that disagrees with the number of commitments, two shares for
 * one seat, or a seat numbered zero all describe a handout that would pass a
 * per-share check and still be unopenable, which is the whole family this
 * letter exists to close.
 */
export function acceptHandout(handout, { curve } = {}) {
  if (!handout || !Array.isArray(handout.shares) || handout.shares.length === 0)
    return { ok: false, why: 'a handout of no shares is not a handout' };
  if (!Array.isArray(handout.commitments) || handout.commitments.length === 0)
    return { ok: false, why: 'a handout that publishes no polynomial cannot be checked' };
  if (handout.commitments.length !== handout.needed)
    return {
      ok: false,
      why: `a threshold of ${handout.needed} is a polynomial of ${handout.needed} `
        + `coefficients, and this handout publishes ${handout.commitments.length}`,
    };
  if (handout.shares.length < handout.needed)
    return {
      ok: false,
      why: `${handout.shares.length} shares cannot carry a threshold of ${handout.needed}`,
    };

  const seats = new Set();
  for (const s of handout.shares) {
    if (!Number.isInteger(s.seat) || s.seat < 1)
      return { ok: false, why: 'a share of seat zero is a share of the secret itself' };
    if (seats.has(s.seat))
      return { ok: false, why: `two shares for seat ${s.seat} are one share` };
    seats.add(s.seat);
    if (typeof s.value !== 'bigint' || s.value < 0n || s.value >= FIELD)
      return { ok: false, why: `seat ${s.seat} holds a value that is not a scalar of the group` };
  }

  const seen = checkHandout({
    shares: handout.shares.map((s) => ({ ...s, commitment: undefined })),
    published: handout.shares.map(() => undefined),
    commitments: handout.commitments,
    curve,
  });
  return seen.ok ? { ok: true, why: seen.why } : { ok: false, why: seen.why };
}
