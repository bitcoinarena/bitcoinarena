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

/** What must happen to a hold invoice. */
export const SETTLE = 'SETTLE';
export const CANCEL = 'CANCEL';

/**
 * WHAT HAPPENS TO EACH PLAYER'S HELD STAKE.
 *
 * Section 13C: "the entry becomes VOID, THE STAKE IS REFUNDED BY LETTING THE
 * HTLC EXPIRE, and the entry is excluded from the pool and from the payout
 * table." The exclusion was already true and measured; what happens to the
 * money was not written anywhere, and a stake nobody decides about is a stake
 * the operator is holding.
 *
 * A stake is a hold invoice: the payer's money is committed and the operator
 * can either SETTLE it - release the preimage and take it - or CANCEL it and
 * let it expire back to the payer. There are only those two, and every entry
 * gets exactly one.
 *
 *   VOID        CANCEL. The fault was the operator's, so the operator takes
 *               nothing. This is the whole of the rule.
 *   everything
 *   else        SETTLE. The stake joins the pot the payout table shares out,
 *               which is why `paid == staked` there over the same entries.
 *
 * AND THE OPERATOR CANNOT COME OUT AHEAD. `settledMsat` is what may be taken
 * and `paidMsat` is what the table hands back, and they are checked equal
 * here rather than assumed - if a VOID stake ever reached the settled side,
 * that equality is what breaks. This says nothing about Lightning: it decides
 * which of the two things is done to each invoice, and doing it is the
 * operator's plumbing.
 */
export function holdSettlement({ roundId, entries, minScore = 0 }) {
  const table = computePayoutTable({ roundId, entries, minScore });
  const paidTo = new Map(table.table.map((r, i) => [i, r.amountMsat]));

  // THE TABLE SAYS WHICH STAKES MOVE, and this only carries out its answer.
  // A VOID entry is not activated at all; a delivered player below the score
  // is activated and keeps their stake, which is the same CANCEL for a
  // different reason.
  const settles = new Set(table.settling);
  const actions = entries.map((e) => (settles.has(e)
    ? { entry: e, action: SETTLE, why: `${e.outcome}: the stake joins the pot the table shares out` }
    : {
      entry: e,
      action: CANCEL,
      why: e.outcome === VOID
        ? 'VOID: the fault was not the player\'s, so the stake goes back'
        : `${e.outcome} below the score: the stake was never at risk`,
    }));

  const activated = entries.filter((e) => e.outcome !== VOID);
  const settledMsat = actions
    .filter((a) => a.action === SETTLE)
    .reduce((s, a) => s + a.entry.stakeMsat, 0n);
  const refundedMsat = actions
    .filter((a) => a.action === CANCEL)
    .reduce((s, a) => s + a.entry.stakeMsat, 0n);
  const paidMsat = [...paidTo.values()].reduce((s, v) => s + v, 0n);

  // A VOID hold that was settled would show up here and nowhere else: the
  // operator would be holding money the table never hands back.
  if (activated.length && settledMsat !== paidMsat)
    throw new Error(
      `the operator would keep ${settledMsat - paidMsat} msat: settled ${settledMsat} `
      + `against ${paidMsat} paid out`);

  return { actions, settledMsat, refundedMsat, paidMsat, table };
}
