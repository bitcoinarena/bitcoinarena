// The payout table. Pure, and identical in node, client and replayer.
//
// Millisatoshi BigInt throughout. No float goes anywhere near money - not for
// a share, not for a rank weight, not for a percentage. Every division here is
// integer division with an explicit remainder, and the remainder is then
// distributed by a rule rather than dropped.

import { Writer } from './encode.js';
import { taggedHash, bytesToBigInt } from './hash.js';
import { TAG } from './constants.js';

export const DELIVERED = 'DELIVERED';
export const FAILED = 'FAILED';
export const FORFEIT = 'FORFEIT';
export const VOID = 'VOID';

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
function remainderOrder(roundId, entries) {
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
 * `entries` carry: pubkey (32 bytes), stakeMsat (BigInt), outcome, score.
 * Returns a payout per entry plus the pool that produced it.
 *
 * The invariant at the end is the whole point of the function. If it does not
 * hold the node REFUSES TO SIGN rather than signing something inconsistent -
 * one assertion that catches a whole class of mistakes for free.
 */
export function computePayoutTable({ roundId, entries, minScore = 0 }) {
  for (const e of entries)
    if (typeof e.stakeMsat !== 'bigint')
      throw new Error('stakes must be BigInt millisatoshi');

  const activated = entries.filter((e) => e.outcome !== VOID);
  const pool = activated
    .filter((e) => e.outcome === FAILED || e.outcome === FORFEIT)
    .reduce((s, e) => s + e.stakeMsat, 0n);

  // Qualification is generous on purpose: a cautious player keeps their stake
  // and simply does not place. Disqualifying them would move their stake into
  // the pool, which is a levy on a legal strategy rather than balance.
  const qualifiers = activated
    .filter((e) => e.outcome === DELIVERED && e.score >= minScore)
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
  // their hold is cancelled and the money never leaves them.
  //
  // This set is returned, so `holdSettlement` cannot decide it differently.
  // Two places deciding which stakes move is two places to get it wrong.
  const keepsTheirStake = (e) => e.outcome === DELIVERED && e.score < minScore;
  const settling = activated.filter((e) => !keepsTheirStake(e));

  const payouts = new Map();
  for (const e of activated) payouts.set(e, 0n);
  for (const e of qualifiers) payouts.set(e, e.stakeMsat);      // stake back

  const k = Math.min(payingRanks(qualifiers.length), qualifiers.length);
  const weights = rankWeights(k);
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
  const staked = settling.reduce((s, e) => s + e.stakeMsat, 0n);

  // Fees and donations are charged ON TOP of the stake at entry (spec 18), so
  // they never appear here - which is exactly why this equality is clean. It
  // no longer waits for a non-empty pool: an empty one was where the cautious
  // player's stake went missing.
  if (qualifiers.length > 0 && paid !== staked)
    throw new Error(`payout invariant broken: paid ${paid} against staked ${staked}`);

  return {
    pool,
    qualifiers: qualifiers.length,
    payingRanks: k,
    settling,
    table: activated.map((e) => ({ pubkey: e.pubkey, amountMsat: payouts.get(e) })),
  };
}

function compareBytes(a, b) {
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
export function noQuorumOutcome({ signatures, needed, equivocationProven }) {
  if (!Number.isInteger(signatures) || signatures < 0)
    throw new Error('signatures is a count of committee members, and cannot be negative');
  if (!Number.isInteger(needed) || needed <= 0)
    throw new Error('the threshold is a positive count of committee members');

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

/** What must happen to a hold invoice, section 23.2. */
export const SETTLE = 'SETTLE';       // release the preimage; the stake enters the pool
export const CANCEL = 'CANCEL';       // hand it back; can only return money to its owner
export const NOTHING = 'NOTHING';     // let it expire; the wallet is refunded automatically

/** 5-of-7, the threshold on both preimage shares and settlement signatures. */
export const SETTLEMENT_THRESHOLD = 5;

/**
 * WHAT EACH OUTCOME DOES TO ITS HOLD INVOICE, AND WHAT IT TAKES TO DO IT.
 *
 * Section 23.2, and the shape of the table is the safety property:
 *
 *   DELIVERED (qualifying)  Cancel the HTLC -> the stake returns to the player
 *                           Requires 5-of-7 settlement signatures; "cancelling
 *                           can only return money to its owner"
 *   FAILED / FORFEIT        Settle the HTLC -> the stake enters the pool wallet
 *                           Requires a FINAL result, an elapsed window, no
 *                           valid objection, at least 5 preimage shares, and
 *                           5-of-7 settlement signatures
 *   VOID                    DO NOTHING. "The HTLC expires and the wallet is
 *                           refunded automatically."
 *
 * "The default path - nobody acting - is always the refund. That is what makes
 * infrastructure failure safe." So VOID is not a cancel: a cancel needs five
 * of seven signatures, and a refund that needed somebody to act would be a
 * refund an operator could withhold by doing nothing. Inaction has to be the
 * safe direction, and only SETTLE moves money away from the player.
 *
 * The conditions come in as facts already established elsewhere - `finality`
 * answers the first three, and the share and signature counts belong to the
 * settlement committee. Nothing is assumed true: a missing one is named.
 */
export function settlementAction({
  outcome, qualifies = false, state, shares = 0, signatures = 0,
  needed = SETTLEMENT_THRESHOLD,
}) {
  if (outcome === VOID)
    return {
      action: NOTHING,
      authorised: true,
      missing: [],
      why: 'the HTLC expires and the wallet is refunded automatically; nobody has to act',
    };

  if (outcome === DELIVERED) {
    const missing = signatures >= needed
      ? [] : [`${signatures} of ${needed} settlement signatures`];
    return {
      action: CANCEL,
      authorised: !missing.length,
      missing,
      why: qualifies
        ? 'the stake returns to the player, and cancelling can only return money to its owner'
        : 'below the score, the stake was never at risk and returns to its owner',
    };
  }

  // FAILED and FORFEIT: the only direction that takes money from a player, and
  // the only one with five conditions on it.
  const missing = [];
  if (state !== 'FINAL') missing.push(`the result is ${state || 'not final'}`);
  if (shares < needed) missing.push(`${shares} of ${needed} preimage shares`);
  if (signatures < needed) missing.push(`${signatures} of ${needed} settlement signatures`);
  return {
    action: SETTLE,
    authorised: !missing.length,
    missing,
    why: missing.length
      ? 'the stake stays where it is until every condition is met'
      : 'the stake enters the pool wallet',
  };
}

/**
 * WHAT HAPPENS TO EACH PLAYER'S HELD STAKE, AND WHAT THE POOL IS MADE OF.
 *
 * Section 13C sends a VOID stake back "by letting the HTLC expire"; 23.2 says
 * which of the three things each outcome does. Only losers' stakes move: the
 * pool wallet is exactly the settled ones, and a qualifier's own stake never
 * leaves them - it comes back by cancelling their own invoice, and what they
 * are PAID from the pool is their winnings on top.
 *
 * That is why the equality below is over SHARES and not over amounts. The
 * table hands a qualifier `stake + share`; the stake half is their own money
 * returning, and only the share half comes out of the pool.
 */
export function holdSettlement({ roundId, entries, minScore = 0 }) {
  const table = computePayoutTable({ roundId, entries, minScore });
  const settles = new Set(table.settling);
  const paidTo = new Map(table.table.map((r, i) => [i, r.amountMsat]));

  const actions = entries.map((e) => {
    const said = settlementAction({
      outcome: e.outcome,
      qualifies: e.outcome === DELIVERED && e.score >= minScore,
      // the conditions themselves are the caller's to establish; this says
      // which action each entry is FOR, which is what the pool depends on
      state: 'FINAL', shares: SETTLEMENT_THRESHOLD, signatures: SETTLEMENT_THRESHOLD,
    });
    // A delivered player never has their stake settled, whatever the table's
    // pot arithmetic says: 23.2 cancels it back to them.
    const action = settles.has(e) && e.outcome !== DELIVERED ? SETTLE : said.action;
    return { entry: e, action, why: said.why };
  });

  const poolMsat = actions
    .filter((a) => a.action === SETTLE)
    .reduce((s, a) => s + a.entry.stakeMsat, 0n);
  const refundedMsat = actions
    .filter((a) => a.action !== SETTLE)
    .reduce((s, a) => s + a.entry.stakeMsat, 0n);

  // What the pool actually hands out: each row's amount less the entry's own
  // stake, since that half never entered the pool.
  const rows = entries.filter((e) => e.outcome !== VOID);
  let sharesMsat = 0n;
  rows.forEach((e, i) => {
    const amount = paidTo.get(i) || 0n;
    sharesMsat += amount > e.stakeMsat ? amount - e.stakeMsat : 0n;
  });

  if (rows.length && poolMsat !== sharesMsat)
    throw new Error(
      `the operator would keep ${poolMsat - sharesMsat} msat: a pool of ${poolMsat} `
      + `against ${sharesMsat} handed out`);

  return {
    actions, poolMsat, refundedMsat, sharesMsat, table,
    settledMsat: poolMsat, paidMsat: sharesMsat,
  };
}
