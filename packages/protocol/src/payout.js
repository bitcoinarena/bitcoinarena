// The payout table. Pure, and identical in node, client and replayer.
//
// Millisatoshi BigInt throughout. No float goes anywhere near money - not for
// a share, not for a rank weight, not for a percentage. Every division here is
// integer division with an explicit remainder, and the remainder is then
// distributed by a rule rather than dropped.

import { Writer, Reader } from './encode.js';
import { taggedHash, bytesToBigInt } from './hash.js';
import { TAG, TYPE_PAYOUT_TABLE, PROTOCOL_VERSION } from './constants.js';

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

  const activated = entries.filter((e) => !isRefund(e.outcome));
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
  if (r.u16() !== PROTOCOL_VERSION) throw new Error('unknown protocol version');
  const roundId = r.bytes32();
  const table = r.vec((rr) => ({ pubkey: rr.bytes32(), amountMsat: rr.u64() }));
  if (r.at !== bytes.length) throw new Error('trailing bytes after the payout table');
  return { roundId, table };
}

/** What §20's "nodes sign the payout-table hash" means, in bytes. */
export const payoutTableId = (t) => taggedHash(TAG.payoutTable, encodePayoutTable(t));

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

/** What must happen to a hold invoice, section 23.2. */
export const SETTLE = 'SETTLE';       // release the preimage; the stake enters the pool
export const CANCEL = 'CANCEL';       // hand it back; can only return money to its owner
export const NOTHING = 'NOTHING';     // let it expire; the wallet is refunded automatically

/** 5-of-7, the threshold on both preimage shares and settlement signatures. */
export const SETTLEMENT_THRESHOLD = 5;

/**
 * The three actions on the wire. Order is protocol: it indexes `actionByte`,
 * and a record that encoded them by name would let two implementations spell
 * one action two ways.
 */
export const ACTIONS = [SETTLE, CANCEL, NOTHING];
export const actionByte = (action) => {
  const i = ACTIONS.indexOf(action);
  if (i < 0) throw new Error('unknown settlement action: ' + action);
  return i;
};
export const actionOf = (byte) => {
  if (!ACTIONS[byte]) throw new Error('unknown settlement action byte: ' + byte);
  return ACTIONS[byte];
};

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
  if (isRefund(outcome))
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
  //
  // THE ROWS COME FROM THE TABLE, not from a second filter over the entries.
  // They are matched to amounts BY INDEX, so a filter here that disagreed with
  // the one there would line the wrong amount up against the wrong entry - and
  // a mutant that changed only this one proved the two could drift without any
  // test noticing.
  const rows = table.activated;
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

/** Where a hold invoice can end up. */
export const HELD = 'HELD';           // in flight: accepted, in nobody's balance
export const SETTLED = 'SETTLED';     // the preimage was released; the pool has it
export const CANCELLED = 'CANCELLED'; // handed back on purpose; the payer has it
export const EXPIRED = 'EXPIRED';     // nobody acted; the payer has it

/**
 * WHERE A HOLD ENDS UP, AS STATE RATHER THAN AS A WORD.
 *
 * 23.1: the HTLC is "in flight - accepted but not settled. It is in nobody's
 * balance." 23.2 gives each outcome one of three things to do to it, and 23.2
 * ends: "The default path - nobody acting - is always the refund. That is what
 * makes infrastructure failure safe."
 *
 * So the state machine has exactly one shape and it leans one way:
 *
 *   nobody acts            EXPIRED, whatever the outcome was. This is the
 *                          default and it returns the money.
 *   NOTHING (a VOID)       EXPIRED. Not CANCELLED - a cancel is an ACT, and it
 *                          needs five of seven; a refund that needed an act is
 *                          one an operator could withhold.
 *   SETTLE, authorised     SETTLED, and the pool has it
 *   CANCEL, authorised     CANCELLED, and the payer has it
 *   anything unauthorised  HELD - and a hold nobody may act on expires, which
 *                          is the same refund by another road
 *
 * NO INVOICE IS ISSUED HERE and none is settled: this says which end a hold
 * must reach. Reaching it is a Lightning endpoint, and everything about
 * `invoice` and `htlc` in this package was a comment until now.
 */
export function holdAfter({ action, authorised = false, nobodyActs = false }) {
  if (![SETTLE, CANCEL, NOTHING].includes(action))
    throw new Error(`${action} is not something that can be done to a hold`);

  if (action === NOTHING || nobodyActs)
    return {
      state: EXPIRED,
      hasIt: 'the payer',
      why: action === NOTHING
        ? 'the HTLC expires and the wallet is refunded: nobody has to act'
        : 'nobody acted, and the default path is always the refund',
    };

  if (!authorised)
    return {
      state: HELD,
      hasIt: 'nobody',
      why: 'in flight, in nobody\'s balance, until every condition is met - and '
        + 'if they never are, it expires back to the payer',
    };

  return action === SETTLE
    ? { state: SETTLED, hasIt: 'the pool', why: 'the preimage was released' }
    : { state: CANCELLED, hasIt: 'the payer', why: 'handed back to its owner' };
}

/**
 * SHOULD A PLAYER PAY THIS INVOICE?
 *
 * The last thing a player does before their money is in flight, and until now
 * nothing checked it. 23.1: the endpoint "issues a hold invoice for
 * `payment_hash`", the player's wallet pays it, and from that moment the stake
 * is committed - so an invoice for the wrong hash or the wrong amount is a
 * mistake that cannot be taken back.
 *
 *   the payment hash   must be the `stakeCommitment` the entry contract
 *                      already carries. An invoice for any other hash commits
 *                      the money to a preimage the committee's shares do not
 *                      reconstruct, so nobody can ever settle it and nobody
 *                      can prove why.
 *   the amount         must be `stakeMsat` exactly. Over, and the player has
 *                      staked more than the round they signed; under, and the
 *                      pool the winner is paid from is short.
 *
 * BOTH COME OFF THE SIGNED ENTRY CONTRACT, so this needs nothing from a node
 * and takes nobody's word: the player is checking an invoice against the thing
 * they themselves signed. Fees and the donation are charged ON TOP at entry
 * (18) and are not part of the held stake, which is why the comparison is
 * exact rather than a floor.
 *
 * IT DOES NOT ISSUE, SETTLE OR CANCEL ANYTHING. There is no Lightning here.
 */
export function invoiceMatchesEntry({ paymentHash, amountMsat, entry }) {
  if (!entry || !(entry.stakeCommitment instanceof Uint8Array))
    return { ok: false, why: 'no entry contract to check the invoice against' };
  if (!(paymentHash instanceof Uint8Array) || paymentHash.length !== 32)
    return { ok: false, why: 'a payment hash is 32 bytes' };
  if (typeof amountMsat !== 'bigint')
    return { ok: false, why: 'an amount is BigInt millisatoshi' };

  const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, '0')).join('');
  if (hex(paymentHash) !== hex(entry.stakeCommitment))
    return {
      ok: false,
      why: `that invoice is for ${hex(paymentHash)}, and this entry commits to `
        + `${hex(entry.stakeCommitment)}: nobody could ever settle it`,
    };
  if (amountMsat !== entry.stakeMsat)
    return {
      ok: false,
      why: `that invoice asks ${amountMsat} msat and the entry staked ${entry.stakeMsat}`,
    };
  return { ok: true, why: 'the hash and the amount are the ones this entry signed' };
}
