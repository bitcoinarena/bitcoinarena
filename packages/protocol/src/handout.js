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
// THE SHARES USED TO BE IN THE CLEAR, and this file said so about itself: "a
// build that pays sats must not use this file as it stands". The hold invoice
// went live and that became true, so it was measured - a stranger holding only
// the public `vss_shares_ref` read all seven shares and rebuilt P - and then
// closed. Every share now travels sealed to ONE seat's key: `seal.js` does the
// agreement and the cipher, this file carries the envelopes.
//
// WHAT A SEAT CAN STILL CHECK, AND WHAT IT CANNOT. It opens its own envelope
// and checks that one share against the published commitments, which is
// exactly what Feldman is for - "confirm its share is consistent without
// reconstructing P". What it can no longer do is check everybody else's, so a
// crooked dealer is caught by WHOEVER HE CHEATED rather than by the first seat
// to look. That is not weaker: a dealer who cheats seat 6 is refused by seat 6,
// and a handout five seats accepted is a handout five seats can open.
import { Writer, Reader } from './encode.js';
import { TAG, TYPE_VSS_HANDOUT, PROTOCOL_VERSION } from './constants.js';
import { taggedHash } from './hash.js';
import { shareOpensTo, splitSecret } from './shares.js';
import { openShare, sealShare, VSS_SEALED_BYTES } from './seal.js';
import { toHex } from './hash.js';

/** A commitment is a compressed point: 33 bytes, sign included. */
export const COMMITMENT_BYTES = 33;

export function encodeHandout(h) {
  const w = new Writer();
  w.u8(TYPE_VSS_HANDOUT);
  w.u16(PROTOCOL_VERSION);
  w.bytes32(h.roundId);
  w.bytes32(h.playerPubkey);
  // THE DEALER'S ONE-TIME KEY. Every seat derives a different secret from it
  // and none of them derives another seat's, so one key on the wire buys
  // seven envelopes that do not open each other.
  w.bytes32(h.ephemeralPubkey);
  // THE THRESHOLD IS ON THE OBJECT because a seat has to know how many
  // coefficients the commitments SHOULD be before it counts them: a dealer who
  // published four commitments for a threshold of five has published a
  // different polynomial, not a shorter list.
  w.u16(h.needed);
  w.vec(h.commitments, (c, ww) => ww.bytes(c, COMMITMENT_BYTES));
  // SORTED BY SEAT, asserted rather than sorted: the order is inside the id
  // the entry names, so a caller that shuffles must be refused and not
  // quietly corrected.
  // WHO EACH ENVELOPE IS FOR IS ON THE WIRE. A seat must be able to find its
  // own without trying every one, and - more to the point - a handout that
  // named no recipients could be re-dealt to a different committee under the
  // same id, which is the id an entry has already signed.
  w.vec(h.shares, (s, ww) => {
    ww.u16(s.seat);
    ww.bytes32(s.seatPubkey);
    ww.bytes(s.sealed, VSS_SEALED_BYTES);
  }, { sortedBy: (a, b) => a.seat - b.seat });
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
    ephemeralPubkey: r.bytes32(),
    needed: r.u16(),
    commitments: r.vec((rr) => rr.bytes(COMMITMENT_BYTES)),
    shares: r.vec((rr) => ({
      seat: rr.u16(),
      seatPubkey: rr.bytes32(),
      sealed: rr.bytes(VSS_SEALED_BYTES),
    })),
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
export function acceptHandout(handout) {
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
  const keys = new Set();
  for (const s of handout.shares) {
    if (!Number.isInteger(s.seat) || s.seat < 1)
      return { ok: false, why: 'a share of seat zero is a share of the secret itself' };
    if (seats.has(s.seat))
      return { ok: false, why: `two shares for seat ${s.seat} are one share` };
    seats.add(s.seat);
    if (!(s.seatPubkey instanceof Uint8Array) || s.seatPubkey.length !== 32)
      return { ok: false, why: `seat ${s.seat} is not addressed to a key` };
    if (!(s.sealed instanceof Uint8Array) || s.sealed.length !== VSS_SEALED_BYTES)
      return { ok: false, why: `seat ${s.seat}'s envelope is not a sealed share` };
    if (keys.has(toHex(s.seatPubkey)))
      return { ok: false, why: 'two seats of that handout are one key, so one of them cannot open its share' };
    keys.add(toHex(s.seatPubkey));
  }

  return { ok: true, why: `${handout.shares.length} sealed shares, threshold ${handout.needed}` };
}

/**
 * OPEN THE ONE ENVELOPE THIS SEAT WAS DEALT, AND CHECK THAT ONE SHARE.
 *
 * 23.1: "each node can confirm its share is consistent without reconstructing
 * P." That is now literal - a node HAS only its own share, so consistency is
 * the only thing it can confirm and the only thing it needs to.
 *
 * A NODE THAT WAS DEALT NOTHING KEEPS NOTHING. Storing a handout it can never
 * open would be storing an envelope addressed to somebody else and calling it
 * custody.
 */
export async function openMyShare(handout, { pubkey, secret, curve } = {}) {
  if (!(pubkey instanceof Uint8Array) || pubkey.length !== 32)
    return { ok: false, why: 'a seat opens a share with its own 32-byte key, and that is not one' };
  const mine = handout.shares.find((s) => toHex(s.seatPubkey) === toHex(pubkey));
  if (!mine)
    return { ok: false, why: 'this node is not one of the seats that handout was dealt to' };

  const opened = await openShare({
    sealed: mine.sealed, seat: mine.seat, secret,
    ephemeralPubkey: handout.ephemeralPubkey, curve,
  });
  if (!opened.ok) return opened;

  // AND THE SHARE HAS TO LIE ON THE PUBLISHED POLYNOMIAL. Opening proves the
  // dealer knew this seat's key; only Feldman proves he cut one polynomial.
  const consistent = shareOpensTo(opened.share, { commitments: handout.commitments, curve });
  if (!consistent.ok) return { ok: false, why: consistent.why };
  return { ok: true, share: opened.share, seat: mine.seat };
}

/**
 * DEAL ONE STAKE PREIMAGE TO A COMMITTEE.
 *
 * The page does this and so does every test, which is the point of it being
 * here: a dealer that two callers build differently is two dealers, and the
 * entry's `vss_shares_ref` names one handout.
 *
 * SEAT NUMBERS ARE 1..n IN THE ORDER THE COMMITTEE WAS GIVEN. They are the x
 * of the polynomial, so they must never be zero - `acceptHandout` refuses that
 * because P(0) IS the secret - and they must be the same numbers the opener
 * uses, which is why they are derived from the list rather than chosen.
 */
export async function dealHandout({ preimage, seats, roundId, playerPubkey,
  ephemeralSecret, ephemeralPubkey, coefficients, needed, curve }) {
  if (!Array.isArray(seats) || !seats.length)
    return { ok: false, why: 'a handout is dealt to a committee, and that is an empty one' };
  const split = splitSecret(preimage, {
    seats: seats.length, needed: needed || undefined, coefficients, curve,
  });
  const shares = [];
  for (const share of split.shares) {
    const seatPubkey = seats[share.seat - 1];
    shares.push({
      seat: share.seat,
      seatPubkey,
      sealed: await sealShare({
        value: share.value, seat: share.seat, seatPubkey, ephemeralSecret, curve,
      }),
    });
  }
  const handout = {
    roundId, playerPubkey, ephemeralPubkey,
    needed: split.commitments.length,
    commitments: split.commitments,
    shares,
  };
  return { ok: true, handout, id: handoutId(handout) };
}
