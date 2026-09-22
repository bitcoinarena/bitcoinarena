// WHO A FILED SLASH OWES, WRITTEN DOWN AND NOT SPENT.
//
// §5A.3's three rulings of 2026-09-22 made this computable, and until they landed it was not: nothing
// said which height "the active census nodes at the slashing height" meant, who "the affected players"
// were, or what happened when one round slashed two nodes. `protocol/src/slash.js` now answers all
// three, and this is the node path that calls them.
//
// RECORDING ONLY. It moves nothing. §5A.3B steps 3 and 5 - the arbitration set signing a transaction
// that spends path B, and the outputs that pay - need MuSig2 over the arbitration keys, which is not
// implemented anywhere in this tree, and an escrow output that no builder exists for. Those are their
// own letter. What a node can do today, from what it already holds, is say what a slash OWES: the bond,
// the census at the named height, the round's seats, the entries the offence harmed, and the split.
//
// WHY A NODE SHOULD DO IT AT ALL BEFORE IT CAN PAY: every observer must recompute the same recipient
// list from chain data at a height the transaction commits to. A node that files a proof and cannot say
// what it implies has filed an assertion, not an accusation - and the first time the numbers are worked
// out should not be the first time money moves.
import {
  slashHeightIsValid, affectedEntries, playersShares, slashDistribution,
} from '../../protocol/src/slash.js';
import { netStakeMsat } from '../../protocol/src/payout.js';
import { toHex } from '../../protocol/src/hash.js';

/**
 * What one filed proof owes, or why it cannot be said yet.
 *
 * `censusAt(height)` is the caller's - a node reads its own chain view, and this must not guess one.
 * `bondSatsOf(outpoint)` likewise: the proof names the bond's OUTPOINT and never its value, so the
 * value comes off the chain entry for it.
 *
 * @returns {{ ok: true, owing }|{ ok: false, why: string }}
 */
export async function slashOwing({
  proof, offence, contract, roundIdBytes, entries = [],
  slashHeight, tipHeight, censusAt, bondSatsOf,
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

  // 3. WHO WAS HARMED - the offence decides, never this.
  const harmed = affectedEntries({ offence, playerPubkey: proof.playerPubkey, entries });
  if (!harmed.ok) return { ok: false, why: harmed.why };

  // 4. THE CENSUS AT THAT HEIGHT, and the round's own seats taken out of it by `slashDistribution`.
  let census;
  try { census = await censusAt(slashHeight); }
  catch (e) { return { ok: false, why: `no census at ${slashHeight}: ${e.message}` }; }
  if (!Array.isArray(census)) return { ok: false, why: `no census at ${slashHeight} to pay out of` };

  // 5. THE TWO HALVES. `slashDistribution` refuses an empty eligible set by name rather than inventing
  //    a recipient for it, and that refusal is passed on as it stands.
  let split;
  try {
    split = slashDistribution({
      bondSats, roundId: roundIdBytes, contract,
      affectedPlayers: harmed.affected.map((e) => e.playerPubkey),
      censusNodes: census, seats: contract.nodes || [],
    });
  } catch (e) { return { ok: false, why: e.message }; }

  // 6. AND THE PLAYERS' HALF PRO RATA BY NET STAKE, which `slashDistribution` divides evenly because it
  //    does not know the stakes. §5A.3 weights it, so the weighted split is what is recorded.
  const byStake = playersShares({ toPlayers: split.toPlayers, affected: harmed.affected, roundId: roundIdBytes });
  if (!byStake.ok) return { ok: false, why: byStake.why };

  return {
    ok: true,
    owing: {
      slashHeight, bondSats, offence,
      node: toHex(proof.nodePubkey),
      bond: `${toHex(proof.bondTxid)}:${proof.bondVout}`,
      toPlayers: split.toPlayers, toNodes: split.toNodes, toDevelopers: split.toDevelopers,
      // one payout contract per affected entry, §5A.3 - a map, never one pooled number
      players: byStake.shares,
      nodes: split.shares,
      censusSeen: census.length, seatsOut: (contract.nodes || []).length,
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
export function entriesForSlash(round, roundIdBytes, { operatorPlayer = null } = {}) {
  const out = [];
  for (const row of round.entriesOf ? round.entriesOf(roundIdBytes) : []) {
    const c = row.entry;
    if (!c || !(c.playerPubkey instanceof Uint8Array)) continue;
    out.push({
      playerPubkey: c.playerPubkey,
      netStakeMsat: netStakeMsat(c),
      // §22A's fee base: an entry that paid is activated. A free round's entries owe nothing and are
      // harmed by no money offence.
      activated: c.stakeMsat > 0n,
      operatorOwn: operatorPlayer ? toHex(c.playerPubkey) === toHex(operatorPlayer) : false,
    });
  }
  return out;
}
