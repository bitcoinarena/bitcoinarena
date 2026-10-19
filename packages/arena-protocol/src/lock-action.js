// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHAT EACH OUTCOME DOES TO ITS STAKE LOCK, AND WHAT IT TAKES TO DO IT (§23.1, §23.2 - the federation's custody, the one
// this network has: §23.6, RULED 2026-09-22 22:59).
//
// A player's stake is a lock in the round's federation: LNv2's OutgoingContract, claimed by the preimage and the claim
// key, forfeited by the claim key to the refund key, refunded after its expiry by the refund key alone. So a lock has
// three ends, and each outcome sends it to one of them:
//
//   CLAIM    a loser's lock (FAILED, FORFEIT, a DELIVERED run below the score does not lose it) is claimed into the
//            round's settlement: the preimage (five of seven shares, §23.4) and the claim key's signature. The only
//            end that takes money from a player, and the only one with five conditions on it.
//   RETURN   a qualifier's own lock is forfeited back to its refund key (forfeit.js, W5b) on 5-of-7 settlement
//            signatures - returning a stake can only return it to its owner.
//   EXPIRE   a VOID: nobody acts, and the lock refunds at its expiry. "The default path - nobody acting - is always the
//            refund. That is what makes infrastructure failure safe."
//
// CUT 6b (RULED 2026-09-24) moved this here from payout.js, where it was written for a hold invoice - SETTLE, CANCEL,
// NOTHING - and deleted that vocabulary. The rule, its conditions, its order on the wire and the pool arithmetic are the
// same; only the names are the lock's. LOCK_ACTIONS keeps the byte order the settlement record (slash.js) was encoded in.
import { computePayoutTable, isRefund, netStakeMsat, DELIVERED, SETTLEMENT_THRESHOLD } from './payout.js';

export const CLAIM = 'CLAIM';     // claimed into the settlement by the preimage and the claim key
export const RETURN = 'RETURN';   // forfeited back to its refund key: can only return money to its owner
export const EXPIRE = 'EXPIRE';   // nobody acts; the lock refunds at its expiry

/** The three ends on the wire. Order is protocol: it indexes `lockActionByte`. */
export const LOCK_ACTIONS = [CLAIM, RETURN, EXPIRE];
export const lockActionByte = (action) => {
  const i = LOCK_ACTIONS.indexOf(action);
  if (i < 0) throw new Error('unknown lock action: ' + action);
  return i;
};
export const lockActionOf = (byte) => {
  if (!LOCK_ACTIONS[byte]) throw new Error('unknown lock action byte: ' + byte);
  return LOCK_ACTIONS[byte];
};

/**
 * THE END ONE OUTCOME SENDS ITS LOCK TO, AND WHAT IS STILL MISSING FOR IT (§23.2). The conditions come in as facts
 * established elsewhere - `finality` answers the state, and the share and signature counts belong to the settlement
 * committee. Nothing is assumed true: a missing one is named.
 */
export function lockAction({
  outcome, qualifies = false, state, shares = 0, signatures = 0,
  needed = SETTLEMENT_THRESHOLD,
}) {
  if (isRefund(outcome))
    return {
      action: EXPIRE,
      authorised: true,
      missing: [],
      why: 'the lock refunds at its expiry; nobody has to act',
    };

  if (outcome === DELIVERED) {
    const missing = signatures >= needed
      ? [] : [`${signatures} of ${needed} settlement signatures`];
    return {
      action: RETURN,
      authorised: !missing.length,
      missing,
      why: qualifies
        ? 'the stake returns to the player, and returning a lock can only return money to its owner'
        : 'below the score, the stake was never at risk and returns to its owner',
    };
  }

  // FAILED and FORFEIT: the only direction that takes money from a player, and the only one with five conditions on it.
  const missing = [];
  if (state !== 'FINAL') missing.push(`the result is ${state || 'not final'}`);
  if (shares < needed) missing.push(`${shares} of ${needed} preimage shares`);
  if (signatures < needed) missing.push(`${signatures} of ${needed} settlement signatures`);
  return {
    action: CLAIM,
    authorised: !missing.length,
    missing,
    why: missing.length
      ? 'the stake stays locked until every condition is met'
      : 'the stake is claimed into the settlement',
  };
}

/**
 * WHAT HAPPENS TO EACH PLAYER'S LOCK, AND WHAT THE POOL IS MADE OF. Only losers' locks are claimed: the pool is exactly
 * the claimed ones, and a qualifier's own lock never leaves them - it returns to its refund key, and what they are PAID
 * from the pool is their winnings on top. So the equality below is over SHARES and not over amounts: the table hands a
 * qualifier `stake + share`, the stake half is their own money returning, and only the share half comes out of the pool.
 */
// `payoutShares`: the round's game's top split (manifest.js payoutRuleForRound), or null for the rank curve.
export function lockActions({ roundId, entries, minScore = 0, payoutShares = null }) {
  const table = computePayoutTable({ roundId, entries, minScore, payoutShares });
  const claims = new Set(table.settling);
  const paidTo = new Map(table.table.map((r, i) => [i, r.amountMsat]));

  const actions = entries.map((e) => {
    const said = lockAction({
      outcome: e.outcome,
      qualifies: e.outcome === DELIVERED && e.score >= minScore,
      // the conditions themselves are the caller's to establish; this says which end each lock is FOR, which is what
      // the pool depends on
      state: 'FINAL', shares: SETTLEMENT_THRESHOLD, signatures: SETTLEMENT_THRESHOLD,
    });
    // A delivered player's lock is never claimed, whatever the table's pot arithmetic says: it returns to them.
    const action = claims.has(e) && e.outcome !== DELIVERED ? CLAIM : said.action;
    return { entry: e, action, why: said.why };
  });

  // A WALK-AWAY IS NEVER A REFUND, EVEN WITH NO QUALIFIER (RULED 2026-09-30): an entry the signer node's own store
  // holds FORFEIT AT THE DOOR (`atTheDoor`: §15, no first mark, or a first mark past the line) has its lock claimed
  // when nobody qualifies, and what it holds is the round's REMAINDER - split by the ruled remainder split, not handed
  // out by the table (lock-settlement.js). Every other loser keeps the no-qualifier expiry: nobody acts on its lock.
  const remainder = table.qualifiers === 0 && actions.some((a) => a.action === CLAIM && a.entry.atTheDoor);
  if (remainder)
    for (const a of actions) {
      if (a.action !== CLAIM || a.entry.atTheDoor) continue;
      a.action = EXPIRE;
      a.why = 'nobody qualifies, so this lock is left to expire back to its player';
    }

  // WHAT EACH LOCK HOLDS is the net stake, so that is what a claim moves and what a return or an expiry hands back. The
  // fee and the donation were never in the stake lock (§23.5).
  const poolMsat = actions
    .filter((a) => a.action === CLAIM)
    .reduce((s, a) => s + netStakeMsat(a.entry), 0n);
  const refundedMsat = actions
    .filter((a) => a.action !== CLAIM)
    .reduce((s, a) => s + netStakeMsat(a.entry), 0n);

  // What the pool actually hands out: each row's amount less the entry's own net stake, since that half never entered
  // the pool. THE ROWS COME FROM THE TABLE, not from a second filter over the entries: they are matched to amounts BY
  // INDEX, so a filter here that disagreed with the one there would line the wrong amount up against the wrong entry.
  const rows = table.activated;
  let sharesMsat = 0n;
  rows.forEach((e, i) => {
    const amount = paidTo.get(i) || 0n;
    const held = netStakeMsat(e);
    sharesMsat += amount > held ? amount - held : 0n;
  });

  const remainderMsat = remainder ? poolMsat : 0n;
  if (rows.length && poolMsat !== sharesMsat + remainderMsat)
    throw new Error(
      `the operator would keep ${poolMsat - sharesMsat} msat: a pool of ${poolMsat} `
      + `against ${sharesMsat} handed out`);

  return {
    actions, poolMsat, refundedMsat, sharesMsat, remainderMsat, table,
    settledMsat: poolMsat, paidMsat: sharesMsat,
  };
}
