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
import { isRefund } from './payout.js';

/** Basis points, and 22A's MUST: the shares sum to exactly this. */
export const DONATION_BPS_TOTAL = 10000;

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

    // ONE RECIPIENT LISTED TWICE IS TWO SHARES FOR ONE PARTY, and the set is
    // "a parameter the network can hold an opinion about" - an opinion it
    // cannot form if the same address can appear under two weights.
    if (seen.has(r.lnurl))
      return { ok: false, why: `${r.lnurl} is listed twice, which is one party with two shares` };
    seen.add(r.lnurl);
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
 */
export function splitDonation({ donationMsat, recipients }) {
  if (typeof donationMsat !== 'bigint')
    return { ok: false, why: 'a donation is BigInt millisatoshi' };
  if (donationMsat < 0n)
    return { ok: false, why: 'a donation cannot be negative' };

  if (donationMsat === 0n)
    return {
      ok: true,
      shares: (Array.isArray(recipients) ? recipients : []).map((r) => ({
        lnurl: r && r.lnurl, amountMsat: 0n,
      })),
      why: 'donations are off for this entry, and the set is irrelevant to it',
    };

  const stands = donationSetStands(recipients);
  if (!stands.ok) return { ok: false, why: stands.why };

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

  return { ok: true, shares, why: `${donationMsat} split over ${shares.length} recipients` };
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
