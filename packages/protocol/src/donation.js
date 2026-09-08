// 22A: THE PLAYER'S DONATION, WHICH GOES TO A SET AND NOT TO AN ADDRESS.
//
// "A donation goes to a set of recipients with declared shares, not to one
// address... `share_bps` are basis points and MUST sum to exactly 10000."
//
// `donationMsat` has been on every Entry Contract since it was written and
// read by nothing - the same state `feeMsat` was in before the fee table.
// This is the arithmetic and the one rule that decides where the money does
// NOT go when a payment fails.
//
// THE ROUNDING IS NOT THE FEE'S ROUNDING, and that is deliberate rather than
// an oversight to be tidied. 22A gives the node fee's remainder to the
// ascending `H(round_id || node_pubkey)` order and gives the donation's to
// "the first recipient in the set as published. Deterministic, and the
// amounts are too small for anything cleverer to be worth its complexity."
// Two rules, written down separately, and copying either onto the other would
// be inventing a third.
//
// WHAT IS DELIBERATELY NOT HERE. 22A also says the set "is named in the Round
// Contract and its hash is part of the contract hash". That is a signed field
// and it moves every round id, so it is a decision before it is work - the
// same split the fee table took before `feeMsat`. And there is no Lightning
// here: a recipient is an opaque `lnurl` string, because this package pays
// nobody and inventing a payment layer to test one would be inventing a
// second protocol.
import { Writer, Reader } from './encode.js';
import { taggedHash } from './hash.js';
import { PROTOCOL_VERSION, TYPE_DONATION_SET, TAG } from './constants.js';
import { isRefund } from './payout.js';

/** Basis points, and 22A's MUST: the shares sum to exactly this. */
export const DONATION_BPS_TOTAL = 10000;

/**
 * AN LNURL IS BECH32, AND BECH32 DECIDES ITS OWN CASE RULES.
 *
 * Two of them, and both are the encoding's, not this file's invention:
 * a string may not be MIXED case, and case carries no meaning - `LNURL1ABC`
 * and `lnurl1abc` are one address.
 *
 * Treating the string as opaque bytes instead was measured and was a hole:
 * `[{LNURL1ABC, 5000}, {lnurl1abc, 5000}]` stood, which is ONE PARTY HOLDING
 * TWO SHARES - exactly what the duplicate check exists to prevent - and the
 * same payee produced two different set ids, so two honest nodes handed the
 * same recipients in different case disagreed about which set was used.
 *
 * FOLDED IN ASCII AND NOT BY `toLowerCase`, deliberately. `toLowerCase` is
 * Unicode and in a Turkish locale maps `I` to a dotless `ı`, so two
 * implementations of this protocol could canonicalise one address two ways and
 * disagree about who is being paid. Bech32 is ASCII; the fold is ASCII.
 */
const upper = (c) => c >= 65 && c <= 90;
const lower = (c) => c >= 97 && c <= 122;

export function canonicalLnurl(lnurl) {
  let out = '';
  for (let i = 0; i < lnurl.length; i++) {
    const c = lnurl.charCodeAt(i);
    out += upper(c) ? String.fromCharCode(c + 32) : lnurl[i];
  }
  return out;
}

export function isMixedCase(lnurl) {
  let hasUpper = false;
  let hasLower = false;
  for (let i = 0; i < lnurl.length; i++) {
    const c = lnurl.charCodeAt(i);
    if (upper(c)) hasUpper = true;
    else if (lower(c)) hasLower = true;
  }
  return hasUpper && hasLower;
}

/**
 * DOES THIS SET STAND?
 *
 * A set whose shares do not sum to exactly 10000 is not a division of the
 * player's donation: under it money is either left over with nobody named to
 * receive it, or promised twice. Either way the player's chosen amount is not
 * what the set hands out, and 22A says MUST.
 *
 * Answered rather than thrown, like every other decision in this package.
 */
export function donationSetStands(recipients) {
  if (!Array.isArray(recipients) || !recipients.length)
    return { ok: false, why: 'a donation goes to a set, and this names nobody' };

  let sum = 0;
  const seen = new Set();
  for (const [at, r] of recipients.entries()) {
    if (!r || typeof r.lnurl !== 'string' || !r.lnurl.length)
      return { ok: false, why: `recipient ${at} has no address to be paid at` };
    if (!Number.isInteger(r.shareBps) || r.shareBps < 0)
      return { ok: false, why: `recipient ${at} has no whole share in basis points` };

    // BECH32 FORBIDS MIXED CASE, so an address in it is not an address.
    if (isMixedCase(r.lnurl))
      return {
        ok: false,
        why: `recipient ${at} is mixed case, which bech32 does not allow in an address`,
      };

    // ONE RECIPIENT LISTED TWICE IS TWO SHARES FOR ONE PARTY, and the set is
    // "a parameter the network can hold an opinion about" - an opinion it
    // cannot form if the same address can appear under two weights.
    //
    // COMPARED CANONICALLY, because case carries no meaning in bech32: the two
    // spellings of one payee are one payee, and listing both was measured
    // standing before this line existed.
    const key = canonicalLnurl(r.lnurl);
    if (seen.has(key))
      return {
        ok: false,
        why: `${r.lnurl} is listed twice, which is one party with two shares`,
      };
    seen.add(key);
    sum += r.shareBps;
  }

  if (sum !== DONATION_BPS_TOTAL)
    return {
      ok: false,
      why: `those shares sum to ${sum} basis points and 22A says exactly `
        + `${DONATION_BPS_TOTAL}: the player's donation is not what that set hands out`,
    };
  return { ok: true, why: `${recipients.length} recipients sharing exactly ${sum} basis points` };
}

/**
 * WHAT EACH RECIPIENT IS OWED OF ONE PLAYER'S DONATION.
 *
 * "Rounding: compute in millisatoshis, floor each share, and give the
 * remainder to the first recipient in the set AS PUBLISHED."
 *
 * So the split is EXACT - the remainder is handed to a named party rather than
 * dropped - and the sum of the shares is the donation, to the millisatoshi.
 * That is a different property from the node fee, where each entry's own floor
 * can collect less than the round's table owes; here there is nothing to
 * collect less of, and no gap for anybody to keep.
 *
 * A PLAYER WHO DONATES NOTHING PAYS NOTHING, and the set is irrelevant to that
 * entry - 22A says so - so a zero donation is answered without judging the
 * set at all.
 *
 * THE ANSWER IS `owed`, NOT `ok`, and the difference is the whole reason it
 * was renamed. A zero donation returns successfully with a set that would NOT
 * stand, because 22A says the set is irrelevant to that entry - and a field
 * called `ok` invites a caller to read that as "this set stands", which it
 * does not say and must never be taken to. `owed` says what this function
 * actually answers: what each recipient is owed. Whether a set stands is
 * `donationSetStands`, and it is a different question with a different name.
 */
export function splitDonation({ donationMsat, recipients }) {
  if (typeof donationMsat !== 'bigint')
    return { owed: false, why: 'a donation is BigInt millisatoshi' };
  if (donationMsat < 0n)
    return { owed: false, why: 'a donation cannot be negative' };

  if (donationMsat === 0n)
    return {
      owed: true,
      shares: (Array.isArray(recipients) ? recipients : []).map((r) => ({
        lnurl: r && r.lnurl, amountMsat: 0n,
      })),
      why: 'donations are off for this entry, and the set is irrelevant to it',
    };

  const stands = donationSetStands(recipients);
  if (!stands.ok) return { owed: false, why: stands.why };

  const shares = recipients.map((r) => ({
    lnurl: r.lnurl,
    amountMsat: (donationMsat * BigInt(r.shareBps)) / BigInt(DONATION_BPS_TOTAL),
  }));

  // The remainder to the first as published - not to the largest share, not
  // to a hash order, and not dropped.
  const handed = shares.reduce((sum, s) => sum + s.amountMsat, 0n);
  shares[0].amountMsat += donationMsat - handed;

  const total = shares.reduce((sum, s) => sum + s.amountMsat, 0n);
  if (total !== donationMsat)
    throw new Error(`donation split broken: ${total} of ${donationMsat}`);

  return { owed: true, shares, why: `${donationMsat} split over ${shares.length} recipients` };
}

/**
 * WHAT ACTUALLY MOVES WHEN A PAYMENT FAILS, and where it does NOT go.
 *
 * 22A: "Payment failure to one recipient does not void the entry or the round.
 * A donation is voluntary and outside the pool; an unreachable LNURL is a
 * failed payment and nothing more. Clients SHOULD report it and MUST NOT
 * redirect the share to the remaining recipients, WHICH WOULD LET ONE
 * UNREACHABLE ENDPOINT QUIETLY REDISTRIBUTE OTHER PEOPLE'S MONEY."
 *
 * So an unpaid share stays unpaid. Every other recipient is owed exactly what
 * it was owed before, and the failure changes one number: what was paid. This
 * is the money-law clause and not a retry policy - whether a client tries
 * again is its business, and where the money may go is not.
 *
 * The entry stands either way: a donation is outside the pool, so a failure
 * here can neither void a round nor touch a stake.
 */
export function donationAfterFailures({ shares, failed = [] }) {
  const out = new Set(failed);
  const paid = [];
  const unpaid = [];
  for (const s of shares) (out.has(s.lnurl) ? unpaid : paid).push({ ...s });

  return {
    paid,
    unpaid,
    paidMsat: paid.reduce((sum, s) => sum + s.amountMsat, 0n),
    unpaidMsat: unpaid.reduce((sum, s) => sum + s.amountMsat, 0n),
    entryStands: true,
    why: unpaid.length
      ? `${unpaid.length} recipient(s) unreachable; their share is not redistributed`
      : 'every recipient was paid its share',
  };
}

/**
 * The donations of a round, for the rounds where somebody wants the total.
 * Refunded entries are excluded for the reason the fee base excludes them: a
 * VOID entry is money that never moved.
 */
export const donatedMsat = (entries) =>
  entries.filter((e) => !isRefund(e.outcome)).reduce((sum, e) => sum + e.donationMsat, 0n);

/**
 * THE SET AS BYTES, so a committee can check one instead of being handed an
 * array.
 *
 * Every other object here that decides money encodes and carries a tagged id -
 * the payout table, the settlement record, the fee claim, the service record,
 * the slash proof - and until this the donation set was the only one that did
 * not. That is what stopped two independent nodes agreeing on WHICH set a
 * player donated under, and nothing could be bound to one.
 *
 * THE ORDER IS PART OF THE SET AND IS NOT SORTED. Everywhere else in this
 * package a vector is sorted so that two honest callers agree - the payout
 * table by pubkey, the committee by key - and here that would be a bug: 22A
 * gives the remainder to "the first recipient in the set AS PUBLISHED", so the
 * order decides who is topped up. A set reordered is a set that pays somebody
 * else the odd millisatoshi, and it must therefore be a different set with a
 * different id.
 *
 * A SET THAT DOES NOT STAND DOES NOT ENCODE. There would otherwise be bytes
 * with a real tagged id naming shares that sum to 9999 - an object that looks
 * exactly as published as an honest one and hands out a different amount than
 * the player chose. Refused at the encoder, so no such id can exist.
 */
export function encodeDonationSet(recipients) {
  const stands = donationSetStands(recipients);
  if (!stands.ok) throw new Error(`that set does not stand: ${stands.why}`);

  const w = new Writer();
  w.u8(TYPE_DONATION_SET);
  w.u16(PROTOCOL_VERSION);
  w.vec(recipients, (r, ww) => {
    // THE ADDRESS, CANONICALLY. 22A's "the client MUST show every recipient
    // before wallet approval - a donation to an undisclosed address is not a
    // donation" is about WHICH payee, and bech32 says case is not part of
    // that: the same list typed in upper and in lower is the same set and must
    // therefore hash to one id, or two honest nodes disagree over spelling.
    ww.str(canonicalLnurl(r.lnurl));
    ww.u16(r.shareBps);
  });
  return w.finish();
}

export function decodeDonationSet(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== TYPE_DONATION_SET) throw new Error('not a donation set');
  if (r.u16() !== PROTOCOL_VERSION) throw new Error('unknown protocol version');
  const recipients = r.vec((rr) => ({ lnurl: rr.str(), shareBps: rr.u16() }));
  if (r.at !== bytes.length) throw new Error('trailing bytes after the donation set');

  // Checked on the way in as well as on the way out: bytes are where a set
  // arrives from a stranger, and a stranger is exactly who might send one that
  // does not stand.
  const stands = donationSetStands(recipients);
  if (!stands.ok) throw new Error(`that set does not stand: ${stands.why}`);
  return recipients;
}

/** What 22A means by naming a set: one hash, over the recipients as published. */
export const donationSetId = (recipients) =>
  taggedHash(TAG.donationSet, encodeDonationSet(recipients));
