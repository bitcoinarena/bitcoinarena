// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// The payout table. Pure, and identical in node, client and replayer.
//
// Millisatoshi BigInt throughout. No float goes anywhere near money - not for
// a share, not for a rank weight, not for a percentage. Every division here is
// integer division with an explicit remainder, and the remainder is then
// distributed by a rule rather than dropped.

import { Writer, Reader } from './encode.js';
import { taggedHash, bytesToBigInt } from './hash.js';
import { TAG, TYPE_PAYOUT_TABLE, PROTOCOL_VERSION, speaksVersion } from './constants.js';

export const DELIVERED = 'DELIVERED';
export const FAILED = 'FAILED';
export const FORFEIT = 'FORFEIT';
export const VOID = 'VOID';

/**
 * An entry that never left the door.
 *
 * Section 14's ladder names both - "VOID / ENTRY_VOID (refund; reachable only
 * from PROVISIONAL)" - and section 18 gives them one pool rule: "VOID and
 * ENTRY_VOID entries neither contribute to nor draw from the pool." 23.2 gives
 * them one hold: do nothing, it expires, the wallet is refunded.
 *
 * So they behave alike everywhere money is counted, and they are still two
 * words, because they say different things about what happened. VOID is a
 * round that was played and could not be settled; ENTRY_VOID is an entry that
 * never activated - section 16: "before stake commitment: no financial entry
 * exists; no loss". Writing the second as the first would record a round
 * nobody played.
 */
export const ENTRY_VOID = 'ENTRY_VOID';

/** The two words that mean the stake goes home and the pool never sees it. */
export const REFUNDS = [VOID, ENTRY_VOID];
export const isRefund = (outcome) => REFUNDS.includes(outcome);

/**
 * WHAT OF AN ENTRY'S STAKE IS GAME MONEY, AND THIS IS THE ONLY PLACE THAT SAYS.
 *
 * 22A, "Collection: inclusive in the stake (changed)": wallet commitment 100
 * sat, node fee 2, donation 2, "net game stake 96 sat -> the pool". "'Play for
 * 100' now means 100 leaves the wallet." So `stakeMsat` is the commitment -
 * the one number the player approves - and the fee and the donation come OUT
 * of it. What is left is what the stake lock holds, what a loser's claim
 * puts in the pool, what a qualifier's returned lock hands back, and what a
 * qualifier's share is weighted by.
 *
 * Until 6e this repo read 18's older sentence instead - fees "charged on top
 * of the stake" - and the net stake did not exist: a loser who had donated 2%
 * credited the pool with 100000 msat where 96000 was game money, and the hold
 * invoice for the net was refused. The spec keeps the fee and the donation OUT
 * of the pool wallet (23.5: "paid from separate entry-time commitments"), and
 * a DELIVERED hold is cancelled back to its player (23.2), so a hold for the
 * whole commitment would hand every winner their own fee back.
 *
 * ALL THREE NUMBERS ARE REQUIRED. An entry with no fee or no donation named is
 * refused rather than read as zero, because zero is exactly the on-top reading
 * coming back through a missing field.
 */
// A FREE ROUND IS THREE ZEROS, NOT THREE MISSING FIELDS. Every entry the door
// takes is decoded from signed bytes, so its three amounts are BigInt whether
// the round asks 0 or 100000; the free round the owner photographed refused at
// 11:15 was a daemon started between two edits, when the fee rule already
// asked for the donation and the door did not yet pass it. Coercing a missing
// or numeric amount to BigInt here would hide exactly that kind of wiring
// fault - and a float stake is refused outright, as it always was.
export function netStakeMsat(e) {
  if (!e || typeof e.stakeMsat !== 'bigint' || typeof e.feeMsat !== 'bigint'
      || typeof e.donationMsat !== 'bigint')
    throw new Error('stakes must be BigInt millisatoshi, and an entry names its stake, its fee '
      + 'and its donation: the net stake is the first less the other two (22A)');
  const stake = e.stakeMsat;
  const fee = e.feeMsat;
  const donation = e.donationMsat;
  if (stake < 0n || fee < 0n || donation < 0n)
    throw new Error('a stake, a fee and a donation cannot be negative');
  const net = stake - fee - donation;
  if (net < 0n)
    throw new Error(`a fee of ${e.feeMsat} and a donation of ${e.donationMsat} come out of a `
      + `stake of ${e.stakeMsat}, and cannot come to more than it`);
  return net;
}

/**
 * Rank weights as EXACT INTEGERS.
 *
 * The curve is geometric with r = 3/4 (spec 18A.4). Written as a float it
 * would be 0.75^(i-1), which is unrepresentable and would put rounding
 * between two nodes' payout tables. Multiplied through by 4^(K-1) it becomes
 *
 *     w_i = 3^(i-1) * 4^(K-i)
 *
 * which is an integer, sums exactly, and gives identical shares everywhere.
 */
export function rankWeights(k) {
  if (k <= 0) return [];
  const w = [];
  for (let i = 1; i <= k; i++) w.push(3n ** BigInt(i - 1) * 4n ** BigInt(k - i));
  return w;
}

/** K = ceil(qualifiers / 4), at least one. Spec 18A.4. */
export const payingRanks = (qualifiers) =>
  qualifiers <= 0 ? 0 : Math.max(1, Math.ceil(qualifiers / 4));

/**
 * The order leftover millisatoshi are handed out in.
 *
 * Deterministic and unguessable in advance: ascending H(round_id || pubkey).
 * Dropping the remainder instead would break the sum invariant below, and
 * giving it to the top rank would be a silent extra prize.
 */
export function remainderOrder(roundId, entries) {
  return entries
    .map((e) => {
      const w = new Writer();
      w.bytes32(roundId);
      w.bytes32(e.pubkey);
      return { e, key: bytesToBigInt(taggedHash(TAG.remainder, w.finish())) };
    })
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((x) => x.e);
}

/**
 * computePayoutTable
 *
 * `entries` carry: pubkey (32 bytes), the entry's own stakeMsat, feeMsat and
 * donationMsat (BigInt), outcome, score. Every amount below is the NET stake
 * (`netStakeMsat`); the commitment itself appears nowhere in the table.
 * Returns a payout per entry plus the pool that produced it.
 *
 * The invariant at the end is the whole point of the function. If it does not
 * hold the node REFUSES TO SIGN rather than signing something inconsistent -
 * one assertion that catches a whole class of mistakes for free.
 */
/**
 * A QUALIFIER (§18): DELIVERED and score >= min_score. One rule, read by the
 * payout table, by the preimage release and by the forfeit (W5b) - a Delivered
 * run below the score is not a qualifier; it keeps its stake by the refund.
 */
export const isQualifier = (e, minScore = 0) => e.outcome === DELIVERED && e.score >= minScore;

/**
 * TOP-N PRIZE SPLITS (feature 3; manifest.js PAYOUT_RULE.TOP_SPLIT). A replayed game's manifest may pay its
 * pot by fixed shares over its top places instead of §18A's curve - [10000] winner takes all, [5000, 3000, 2000] the
 * classic 50/30/20. The shares are basis points of the pot: 1 to PAYOUT_SHARES_MAX of them, each a whole number of at
 * least 1, none above the place before it (a lower place is never paid more than a higher one), together exactly
 * PAYOUT_SHARES_TOTAL - so no basis point is left for anyone to keep, and none is invented. One rule, read by the
 * manifest's encoder (what a developer may sign) and by `computePayoutTable` (what a table may be computed with).
 */
export const PAYOUT_SHARES_MAX = 10;
export const PAYOUT_SHARES_TOTAL = 10000;
export function payoutSharesFit(shares) {
  if (!Array.isArray(shares) || shares.length < 1 || shares.length > PAYOUT_SHARES_MAX)
    return { ok: false, why: `a top split names 1 to ${PAYOUT_SHARES_MAX} shares` };
  for (let i = 0; i < shares.length; i++) {
    const s = shares[i];
    if (!Number.isInteger(s) || s < 1 || s > PAYOUT_SHARES_TOTAL)
      return { ok: false, why: `a top split's share is a whole number of basis points, 1 to ${PAYOUT_SHARES_TOTAL}; place ${i + 1} names ${s}` };
    if (i > 0 && s > shares[i - 1])
      return { ok: false, why: `a top split never pays a lower place more: place ${i + 1} names ${s} bps after ${shares[i - 1]}` };
  }
  const sum = shares.reduce((t, s) => t + s, 0);
  if (sum !== PAYOUT_SHARES_TOTAL) return { ok: false, why: `a top split's shares come to ${PAYOUT_SHARES_TOTAL} bps (the whole pot); these come to ${sum}` };
  return { ok: true };
}

// `payoutShares`: the round's game's top split (manifest.js payoutSharesOf), or null for §18A's rank curve - the default,
// so every caller that names none computes exactly the table it always did.
export function computePayoutTable({ roundId, entries, minScore = 0, payoutShares = null }) {
  if (payoutShares !== null && payoutShares !== undefined) {
    const fit = payoutSharesFit(payoutShares);
    if (!fit.ok) throw new Error(fit.why);
  }
  const split = payoutShares !== null && payoutShares !== undefined;
  const net = new Map(entries.map((e) => [e, netStakeMsat(e)]));

  const activated = entries.filter((e) => !isRefund(e.outcome));
  const pool = activated
    .filter((e) => e.outcome === FAILED || e.outcome === FORFEIT)
    .reduce((s, e) => s + net.get(e), 0n);

  // Qualification is generous on purpose: a cautious player keeps their stake
  // and simply does not place. Disqualifying them would move their stake into
  // the pool, which is a levy on a legal strategy rather than balance.
  const qualifiers = activated
    .filter((e) => isQualifier(e, minScore))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      // ties decided by the same rule the remainder uses, so the order is not
      // the order the entries happened to arrive in
      return compareBytes(a.pubkey, b.pubkey);
    });

  // WHOSE STAKE ACTUALLY ENTERS THE POT.
  //
  // Not every activated entry. A delivered player below the score "keeps their
  // stake and simply does not place" - the comment above has always said so -
  // and the table paid them ZERO, which with a settled hold is the operator
  // keeping it. With no loser in the round the pool is empty, the check below
  // was skipped, and nothing noticed. They are excluded from the pot instead:
  // their lock returns to them and the money never leaves them.
  //
  // This set is returned, so `lockActions` (lock-action.js) cannot decide it differently.
  // Two places deciding which stakes move is two places to get it wrong.
  const keepsTheirStake = (e) => e.outcome === DELIVERED && e.score < minScore;
  const settling = activated.filter((e) => !keepsTheirStake(e));

  const payouts = new Map();
  for (const e of activated) payouts.set(e, 0n);
  for (const e of qualifiers) payouts.set(e, net.get(e));       // net stake back

  // THE PAYING PLACES: §18A's K = ceil(qualifiers / 4) under the curve; under a top split, its places - or every
  // qualifier, when fewer qualified than it has places
  const k = split ? Math.min(payoutShares.length, qualifiers.length)
    : Math.min(payingRanks(qualifiers.length), qualifiers.length);

  // 22A'S NET-STAKE WEIGHTING (M3.2-6e, ruled 2026-09-13, pick A). With an
  // inclusive donation "players no longer contribute equally", and left there
  // "donating would be rewarded twice". So within the paying ranks a player's
  // weight is its §18A rank weight TIMES its own net stake, the pool is split
  // in proportion to those weights - each share floored - and the leftover goes
  // out by §18A.6's rule, ascending H(round_id || pubkey), unchanged. The pool
  // is spent exactly.
  //
  // WITH EVERY NET EQUAL THE NET CANCELS EXACTLY: floor(pool*w*n / (W*n)) is
  // floor(pool*w / W), so such a table is byte-identical to the unweighted one
  // and no round played with no donation moves.
  //
  // THE LIMIT, ACCEPTED: with one paying rank - every round of four qualifiers
  // or fewer - the winner takes the whole pool whatever it donated; "no double
  // reward for donating" bites only when two or more ranks pay.
  //
  // Measured before (TASKBOOK, 6e): qualifiers with different nets were refused
  // and every hold expired - one 2% donor, and the pool got 0 of the loser's
  // 98000 msat.
  //
  // A TOP SPLIT IS THE SAME ARITHMETIC WITH ITS SHARES FOR THE CURVE: place i's weight is its share in bps
  // times its own net stake, so 22A's pick A holds for it unchanged (no double reward for donating; with every net equal
  // the net cancels and the pot is split exactly by the shares), the floors and the leftover go exactly as above, and the
  // pot is spent exactly.
  //
  // FEWER QUALIFIERS THAN PLACES: the unused places' shares go to the qualifiers PRO RATA TO THEIR OWN SHARES - the
  // weights are renormalised over the places filled, so [5000, 3000, 2000] with two qualifiers pays 5000/8000 and
  // 3000/8000 of the pot (62.5 % / 37.5 %), and with one, the whole pot. Picked over the alternatives because it is no
  // second rule (the same weighted split, over fewer places), it keeps the order of the places (a higher place still never
  // gets less), and it hands out the whole pot with no share left for an operator to keep; "unused shares to the winner"
  // would be a silent extra prize for first place, and "unused shares split evenly" would bend the proportions between
  // the places the developer signed.
  const weights = (split ? payoutShares.slice(0, k).map((s) => BigInt(s)) : rankWeights(k))
    .map((w, i) => w * net.get(qualifiers[i]));
  const total = weights.reduce((s, w) => s + w, 0n);

  let handed = 0n;
  if (total > 0n && pool > 0n) {
    for (let i = 0; i < k; i++) {
      const share = (pool * weights[i]) / total;              // floor
      payouts.set(qualifiers[i], payouts.get(qualifiers[i]) + share);
      handed += share;
    }
    // whatever the floors left behind, one millisatoshi at a time
    let left = pool - handed;
    if (left > 0n) {
      const order = remainderOrder(roundId, qualifiers.slice(0, k));
      for (let i = 0; left > 0n; i = (i + 1) % order.length) {
        payouts.set(order[i], payouts.get(order[i]) + 1n);
        left -= 1n;
      }
      handed = pool;
    }
  }

  const paid = [...payouts.values()].reduce((s, v) => s + v, 0n);
  const staked = settling.reduce((s, e) => s + net.get(e), 0n);

  // The fee and the donation come out of the commitment before anything here
  // (22A), so the equality is over NET stakes and neither appears in it. It
  // no longer waits for a non-empty pool: an empty one was where the cautious
  // player's stake went missing.
  if (qualifiers.length > 0 && paid !== staked)
    throw new Error(`payout invariant broken: paid ${paid} against staked ${staked}`);

  return {
    pool,
    qualifiers: qualifiers.length,
    payingRanks: k,
    settling,
    activated,
    table: activated.map((e) => ({ pubkey: e.pubkey, amountMsat: payouts.get(e) })),
  };
}

/**
 * THE TABLE AS BYTES, so a node can sign one thing and a stranger can check
 * the same thing years later.
 *
 * §20 fixes `F` and says "nodes sign the payout-table hash" - it does not fix
 * the bytes that hash is taken over. `TYPE_PAYOUT_TABLE` was reserved for this
 * object before anything used it, so filling that slot is the same move the
 * objection made when the spec gave a field list and no encoding: the layout
 * is written down here rather than left for two implementations to guess at
 * differently.
 *
 * THE ROUND IS IN IT. Without it a table is a list of amounts that could
 * belong to any round with the same players, and a signature over it would
 * carry across rounds - which is exactly the replay a tagged hash exists to
 * stop one level down.
 *
 * THE ORDER IS THE TABLE'S OWN. `computePayoutTable` returns rows in
 * `activated` order, which is the caller's entry order, so it is sorted here
 * by pubkey: two honest nodes handed the same entries in a different order
 * must sign the same bytes, or `F` being deterministic buys nothing.
 */
export function encodePayoutTable({ roundId, table }) {
  const w = new Writer();
  w.u8(TYPE_PAYOUT_TABLE);
  w.u16(PROTOCOL_VERSION);
  w.bytes32(roundId);
  const rows = [...table].sort((a, b) => compareBytes(a.pubkey, b.pubkey));
  w.vec(rows, (row, ww) => {
    ww.bytes32(row.pubkey);
    ww.u64(row.amountMsat);
  });
  return w.finish();
}

export function decodePayoutTable(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== TYPE_PAYOUT_TABLE) throw new Error('not a payout table');
  if (!speaksVersion(r.u16())) throw new Error('unknown protocol version');
  const roundId = r.bytes32();
  const table = r.vec((rr) => ({ pubkey: rr.bytes32(), amountMsat: rr.u64() }));
  if (r.at !== bytes.length) throw new Error('trailing bytes after the payout table');
  return { roundId, table };
}

/** What §20's "nodes sign the payout-table hash" means, in bytes. */
export const payoutTableId = (t) => taggedHash(TAG.payoutTable, encodePayoutTable(t));

// Exported because `interest.js` needs the same total order over ids, and a
// second copy of a comparator is a second place for it to drift - the reason
// `slotsForRole` imports 22A's pool mapping rather than restating it.
export function compareBytes(a, b) {
  for (let i = 0; i < a.length && i < b.length; i++)
    if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

/**
 * WHAT AN ENTRY BECOMES WHEN THE COMMITTEE COULD NOT AGREE.
 *
 * Section 13C's no-quorum rule, and its asymmetry is the whole of it: "a
 * player cannot manufacture a refund by causing disagreement, because the only
 * way a player can cause it is equivocation, and equivocation forfeits.
 * Everything else that goes wrong is the infrastructure's fault and refunds."
 *
 *   a result with 5-of-7            the committee agreed; this rule does not
 *                                   apply and says so rather than guessing
 *   a proven fork, no quorum        FORFEIT. The stake joins the loser pool.
 *   no proof, no quorum             VOID. The entry is excluded from the pool
 *                                   and from the payout table, and the stake
 *                                   goes back.
 *
 * THE PROOF IS TAKEN AS ALREADY CHECKED, and that is deliberate rather than
 * lax: `provesEquivocation` verifies signatures and needs a curve, this
 * package carries none, and a decision that re-verified would need one here.
 * The caller passes what it has verified - a node that publishes a proof has
 * verified it, and a caller that passes `true` on an unchecked object has
 * forfeited somebody's stake on its own say-so.
 *
 * PLAYER_LOST IS NOT A WORD HERE. FORFEIT already names the case where the
 * player's own conduct costs the stake, and a synonym would be a second word
 * for one outcome and a second place to get it wrong.
 */
export function noQuorumOutcome({ signatures, needed, equivocationProven, state }) {
  if (!Number.isInteger(signatures) || signatures < 0)
    throw new Error('signatures is a count of committee members, and cannot be negative');
  if (!Number.isInteger(needed) || needed <= 0)
    throw new Error('the threshold is a positive count of committee members');

  // A FINAL RESULT CANNOT BE VOIDED, AND THIS IS WHERE THAT IS SAID.
  //
  // Section 14's ladder: "PROVISIONAL -> VOID / ENTRY_VOID (refund; REACHABLE
  // ONLY FROM PROVISIONAL)", and its opening line: "once a player's result is
  // FINAL, later infrastructure failure does not erase it."
  //
  // Measured before this refusal existed: a result that five committee members
  // had signed, whose objection window had closed, answered FINAL - and this
  // function, asked afterwards with a low count, answered VOID. Both were
  // right on their own and nothing crossed them, so a settled round could be
  // refunded after the fact. That is the escape hatch section 14 exists to
  // shut, and it is the operator's as much as the player's: a node that went
  // quiet after finality could unmake a loss.
  if (state === 'FINAL')
    return {
      outcome: null,
      why: 'that result is already FINAL, and a later failure does not erase it: '
        + 'VOID is reachable only from PROVISIONAL',
    };

  if (signatures >= needed)
    return { outcome: null, why: `the committee agreed: ${signatures} of ${needed}` };

  if (equivocationProven === true)
    return {
      outcome: FORFEIT,
      why: `no quorum at ${signatures} of ${needed}, and the player signed two `
        + 'chains: 13B forfeits the entry',
    };

  return {
    outcome: VOID,
    why: `no quorum at ${signatures} of ${needed}, and nothing shows the player `
      + 'caused it: the fault is the operator side and the stake goes back',
  };
}

/**
 * 5-of-7, the threshold on both preimage shares and settlement signatures. What each outcome does to its stake lock
 * under it is lock-action.js (§23.2): the hold invoice's vocabulary that stood here - its three actions and their wire
 * bytes, its settle-or-cancel split, its state machine and its invoice check - is deleted with the custody it served
 * (§23.6, RULED 2026-09-22 22:59; cut 6b, RULED 2026-09-24).
 */
export const SETTLEMENT_THRESHOLD = 5;
