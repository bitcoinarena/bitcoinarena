// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHO A FILED SLASH OWES, WRITTEN DOWN AND NOT SPENT.
//
// §5A.3 (slashing rule v2, RULED 2026-11-02, kanban #976) says what a slash pays: each affected player's real loss, once, and the rest to the
// protocol reserves. `arena-protocol/src/slash.js` computes it, and this is the node path that calls it.
//
// RECORDING ONLY. It moves nothing: the arbitration set signs and pays (arbiter.js). What a node can do from what it already holds is say what a
// slash OWES, so that anyone can recompute it before any money moves and the first time the numbers are worked out is not the first time they count.
import { slashHeightIsValid, affectedEntries, realLosses, slashDistribution, TWO_RESULTS } from '../../arena-protocol/src/slash.js';
import { netStakeMsat } from '../../arena-protocol/src/payout.js';
import { toHex } from '../../arena-protocol/src/hash.js';

/**
 * What one filed proof owes, or why it cannot be said yet.
 *
 * `bondSatsOf(outpoint)` is the caller's: the proof names the bond's OUTPOINT and never its value, so the value comes off the chain entry for it.
 * `entries` are the round's as they settled (`entriesForSlash` with its `outcomeOf`). `settledOnFalse` says the contradicted run is the one the
 * round settled on - a late objection; after an objection in time the result was corrected before any money moved, so nobody has a loss. `paid` is
 * what earlier proofs of this round pay (key hex -> msat): the proofs of a round go in ascending proof id. `payoutShares` the round's game's split.
 *
 * @returns {{ ok: true, owing }|{ ok: false, why: string }}
 */
export async function slashOwing({
  proof, offence, contract, roundIdBytes, entries = [], signed, replayed, settledOnFalse = false, paid = new Map(), payoutShares = null,
  slashHeight, tipHeight, bondSatsOf,
} = {}) {
  if (!proof || !contract) return { ok: false, why: 'a slash owes nothing without its proof and the round' };

  // 1. THE HEIGHT THE ARBITRATION SET NAMES, checked before anything is read at it.
  const height = slashHeightIsValid({ slashHeight, censusHeight: contract.censusHeight, tipHeight });
  if (!height.ok) return { ok: false, why: height.why };

  // 2. THE BOND'S VALUE. The proof names `bondTxid`/`bondVout` and no amount; the chain has the amount.
  let bondSats;
  try { bondSats = await bondSatsOf({ txid: proof.bondTxid, vout: proof.bondVout }); }
  catch (e) { return { ok: false, why: `the bond's value could not be read: ${e.message}` }; }
  if (typeof bondSats !== 'bigint' || bondSats <= 0n)
    return { ok: false, why: `no bond output at ${toHex(proof.bondTxid).slice(0, 16)}:${proof.bondVout}` };

  // 3. WHO THE OFFENCE CAN HAVE HARMED - the offence decides, never this.
  const harmed = affectedEntries({ offence, playerPubkey: proof.playerPubkey, entries, signed, replayed });
  if (!harmed.ok) return { ok: false, why: harmed.why };

  // 4. THE REAL LOSS: a doubled result with no replay and an objection in time show none (§5A.3).
  const truth = settledOnFalse && offence !== TWO_RESULTS && replayed ? [{ pubkey: proof.playerPubkey, outcome: replayed.outcome, score: replayed.score }] : [];
  let split;
  try {
    const losses = realLosses({ roundId: roundIdBytes, entries, truth, affected: harmed.affected, minScore: contract.minScore, payoutShares, protocolVersion: contract.protocolVersion });
    split = slashDistribution({ escrowSats: bondSats, roundId: roundIdBytes, contract, losses, paid });
  } catch (e) { return { ok: false, why: e.message }; }

  return {
    ok: true,
    owing: {
      slashHeight, bondSats, offence,
      node: toHex(proof.nodePubkey),
      bond: `${toHex(proof.bondTxid)}:${proof.bondVout}`,
      // one payout contract per entry with a loss, §5A.3 - a map, never one pooled number; before the transaction's fees
      players: split.players, playersMsat: split.playersMsat, reservesMsat: split.reservesMsat, shortMsat: split.shortMsat,
    },
  };
}

/**
 * The entries of a round in the shape `affectedEntries` wants, off a node's own store.
 *
 * `entriesOf` hands back the DECODED contract under `entry`; the first version of this read a
 * `contract` column that row does not carry, decoded undefined, threw, and swallowed it - so every
 * round looked like a round with no entries and every slash looked like it harmed nobody. A `continue`
 * on a decode failure is the right shape for bytes off the wire and the wrong shape for a field name,
 * which is why the field is now read as the store returns it and nothing is decoded twice.
 */
export function entriesForSlash(round, roundIdBytes, { operatorPlayer = null, outcomeOf = null } = {}) {
  const out = [];
  for (const row of round.entriesOf ? round.entriesOf(roundIdBytes) : []) {
    const c = row.entry;
    if (!c || !(c.playerPubkey instanceof Uint8Array)) continue;
    const settled = outcomeOf ? outcomeOf(row.entryId) : null;
    out.push({ ...entryForSlash(c, operatorPlayer), ...(settled ? { outcome: settled.outcome, score: settled.score } : {}) });
  }
  return out;
}

/** One decoded entry contract in that shape: the arbiter reads them off a seat's GET /audit-run, not off a store. */
export function entryForSlash(c, operatorPlayer = null) {
  return {
    playerPubkey: c.playerPubkey,
    // what F reads (§20): the same key under its name there, and the stake's parts
    pubkey: c.playerPubkey, stakeMsat: c.stakeMsat, feeMsat: c.feeMsat, donationMsat: c.donationMsat,
    netStakeMsat: netStakeMsat(c),
    // §22A's fee base: an entry that paid is activated. A free round's entries owe nothing and are
    // harmed by no money offence.
    activated: c.stakeMsat > 0n,
    operatorOwn: operatorPlayer ? toHex(c.playerPubkey) === toHex(operatorPlayer) : false,
  };
}
