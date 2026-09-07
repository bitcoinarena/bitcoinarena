// THE STAKE PREIMAGE, SPLIT SEVEN WAYS SO FIVE CAN PUT IT BACK.
//
// Section 23.1: "The player splits P with verifiable secret sharing (Shamir,
// threshold 5-of-7) and encrypts one share to each settlement-committee
// member; vss_shares_ref points at the published shares. Verifiability means
// each node can confirm its share is consistent without reconstructing P."
//
// And 23.4 says what it buys: "Settling a loser's HTLC requires reconstructing
// P, which requires 5 of the 7 shares, which the mechanical rule releases only
// against a FINAL result." So four colluding settlement nodes hold nothing at
// all, and that is the property measured here rather than asserted.
//
// THE FIELD IS 2^521 - 1, a Mersenne prime anybody can check, and it is used
// because a 32-byte preimage has to fit in one field element with room to
// spare. Reducing P into a smaller field would change the number whose hash
// the player already committed to.
//
// Every operation is exact integer arithmetic on BigInt. No float goes near
// this, for the same reason none goes near the payout table.
//
// WHAT "VERIFIABLE" MEANS HERE, AND WHAT IT DOES NOT. Each share carries a
// commitment a holder can check against the share it was given, so a share
// corrupted in transit or swapped by whoever passed it on is caught without
// reconstructing anything. That is the literal reading of 23.1's sentence.
// It is NOT Feldman: it does not prove the dealer used ONE polynomial for all
// seven seats, which needs commitments in a group with a hard discrete log,
// and this package carries no group for the same reason it carries no curve.
// A dealer who wants to hand out inconsistent shares is caught at
// RECONSTRUCTION rather than at handout, and the price of that is measured
// rather than guessed: splitting with two polynomials and giving three seats
// the second one leaves every share passing its own commitment and NONE of the
// twenty-one five-subsets able to open the committed P. Closing that at
// handout needs commitments in a group with a hard discrete log - Feldman -
// and this package carries no group for the same reason it carries no curve.
// What is closed here instead is the quieter half: a subset that rebuilds
// SOMETHING is no longer mistaken for one that rebuilt P.
import { taggedHash, toHex } from './hash.js';
import { TAG } from './constants.js';
import { sha256bytes } from '../../core/src/sha256.js';

/** 2^521 - 1. A 32-byte secret is nowhere near it, which is the point. */
export const FIELD = (1n << 521n) - 1n;

/** 5-of-7, the same threshold as the receipts and the signatures. */
export const SHARES_NEEDED = 5;
export const SHARES_TOTAL = 7;

const mod = (n) => ((n % FIELD) + FIELD) % FIELD;

/** Fermat, since the field is prime: a^(p-2) is a's inverse. */
function inverse(a) {
  let result = 1n;
  let base = mod(a);
  let e = FIELD - 2n;
  while (e > 0n) {
    if (e & 1n) result = mod(result * base);
    base = mod(base * base);
    e >>= 1n;
  }
  return result;
}

const toBigInt = (bytes) => {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
};
const toBytes32 = (v) => {
  const out = new Uint8Array(32);
  let n = v;
  for (let i = 31; i >= 0; i--) { out[i] = Number(n & 255n); n >>= 8n; }
  if (n !== 0n) throw new Error('that value does not fit in 32 bytes');
  return out;
};

/** What a seat can check its own share against, without reconstructing. */
export const shareCommitment = (seat, value) =>
  taggedHash(TAG.vssShare, new TextEncoder().encode(`${seat}:${value.toString(16)}`));

/**
 * Split a 32-byte secret into `seats` shares, `needed` of which rebuild it.
 *
 * The polynomial's constant term is the secret and the rest are the caller's
 * randomness - injected, because this package has no business deciding where
 * randomness comes from, and a test needs the same split twice.
 */
export function splitSecret(secret, { seats = SHARES_TOTAL, needed = SHARES_NEEDED, coefficients } = {}) {
  if (!(secret instanceof Uint8Array) || secret.length !== 32)
    throw new Error('a stake preimage is 32 bytes');
  if (!Number.isInteger(needed) || needed < 2)
    throw new Error('a threshold below two is not a threshold');
  if (!Number.isInteger(seats) || seats < needed)
    throw new Error(`${seats} seats cannot carry a threshold of ${needed}`);
  if (!Array.isArray(coefficients) || coefficients.length !== needed - 1)
    throw new Error(`a threshold of ${needed} needs ${needed - 1} coefficients`);

  const a = [toBigInt(secret), ...coefficients.map(mod)];
  const shares = [];
  for (let seat = 1; seat <= seats; seat++) {
    let value = 0n;
    for (let j = a.length - 1; j >= 0; j--) value = mod(value * BigInt(seat) + a[j]);
    shares.push({ seat, value, commitment: shareCommitment(seat, value) });
  }
  return { shares, needed, seats };
}

/** Does this share match what was published for its seat? */
export function shareIsConsistent(share, commitment) {
  return toHex(shareCommitment(share.seat, share.value)) === toHex(commitment);
}

/**
 * Put the secret back from `needed` shares, and refuse below that.
 *
 * REFUSES, rather than answering something. Four shares interpolate a
 * perfectly good polynomial of their own - they simply do not name P - and a
 * function that handed that back would be handing back a wrong preimage that
 * looks exactly like a right one.
 */
export function reconstruct(shares, { needed = SHARES_NEEDED, stakeCommitment } = {}) {
  const seats = new Set(shares.map((s) => s.seat));
  if (seats.size !== shares.length)
    throw new Error('two shares for one seat are one share');
  if (shares.length < needed)
    throw new Error(`${shares.length} shares cannot reconstruct anything: ${needed} are needed`);

  const use = shares.slice(0, needed);
  let secret = 0n;
  for (let i = 0; i < use.length; i++) {
    let term = use[i].value;
    for (let j = 0; j < use.length; j++) {
      if (i === j) continue;
      const xi = BigInt(use[i].seat);
      const xj = BigInt(use[j].seat);
      term = mod(term * mod(-xj) * inverse(xi - xj));
    }
    secret = mod(secret + term);
  }
  const opened = toBytes32(secret);

  // AND IF THE COMMITMENT IS TO HAND, THE ANSWER IS CHECKED AGAINST IT.
  //
  // Measured: a dealer who splits with two polynomials hands out seven shares
  // that each pass their own seat, and of the twenty-one five-subsets, TWO
  // still produce a well-formed 32-byte value that is not P. Handed back
  // unchecked, that is a wrong preimage which looks exactly like a right one.
  // `stakeCommitment` is H(P) and it is in the entry contract the player
  // signed, so a caller settling a stake always has it.
  if (stakeCommitment !== undefined) {
    if (toHex(sha256bytes(opened)) !== toHex(stakeCommitment))
      throw new Error('those shares rebuild something that is not the committed preimage');
  }
  return opened;
}

/**
 * Try every combination of `needed` shares until one opens the committed
 * preimage, and say how the whole set behaved.
 *
 * This is what a settlement committee actually does, and it is also the
 * measurement of the hole below it: a dealer is free to hand out shares that
 * each pass their seat and yet leave NO subset able to open P.
 */
export function openStake(shares, { needed = SHARES_NEEDED, stakeCommitment } = {}) {
  const subsets = [];
  const walk = (from, taken) => {
    if (taken.length === needed) { subsets.push(taken.slice()); return; }
    for (let i = from; i < shares.length; i++) { taken.push(shares[i]); walk(i + 1, taken); taken.pop(); }
  };
  walk(0, []);

  let opened = null;
  let openedBy = null;
  let refused = 0;
  for (const five of subsets) {
    try {
      const back = reconstruct(five, { needed, stakeCommitment });
      if (opened === null) { opened = back; openedBy = five.map((s) => s.seat); }
    } catch { refused++; }
  }
  return {
    ok: opened !== null,
    preimage: opened,
    openedBy,
    subsets: subsets.length,
    opens: subsets.length - refused,
    refused,
    why: opened === null
      ? `none of the ${subsets.length} ways to pick ${needed} shares opens the committed preimage`
      : `opened by seats ${openedBy.join(',')}`,
  };
}
