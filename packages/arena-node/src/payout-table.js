// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// FIVE OF SEVEN AGREEING ON WHAT THE ROUND OWES, BEFORE A SATOSHI MOVES.
//
// §20: "Nodes sign the payout-table hash; 5-of-7 matching signatures make it
// final. A node signing a table that does not equal F(...) of its published
// inputs is slashable." `encodePayoutTable` and `payoutTableId` have existed
// since letter 20 with ZERO callers outside their own tests. This is the
// caller.
//
// IT IS A SECOND THRESHOLD AND NOT THE SAME ONE. Five of seven signed RESULTS
// make each run final; five of seven signed TABLES make what the round owes
// final. A node can agree that a player lost and still disagree about the
// arithmetic that pays the winner, and the second is what money leaves on.
//
// THE TABLE IS NOT TRUSTED, IT IS RECOMPUTED. A record from a peer carries the
// table id it signed; this node computes F(its own inputs) itself and counts
// only signatures over THAT id. A peer signing something else is not a
// disagreement to average out - it is a table nobody here will spend against.
import { schnorr } from '@noble/curves/secp256k1.js';
import { computePayoutTable, payoutTableId, encodePayoutTable } from '../../arena-protocol/src/payout.js';
import { receiptsNeeded } from '../../arena-protocol/src/genesis.js';
import { toHex } from '../../arena-protocol/src/hash.js';

/** node key, the id it signed, and the signature: a fixed 128 bytes. */
export const SIGNED_TABLE_BYTES = 32 + 32 + 64;

export function joinSignedTable({ nodePubkey, tableId, signature }) {
  const out = new Uint8Array(SIGNED_TABLE_BYTES);
  out.set(nodePubkey, 0);
  out.set(tableId, 32);
  out.set(signature, 64);
  return out;
}

export function splitSignedTable(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== SIGNED_TABLE_BYTES)
    throw new Error(`a signed payout table is ${SIGNED_TABLE_BYTES} bytes`);
  return {
    nodePubkey: bytes.subarray(0, 32),
    tableId: bytes.subarray(32, 64),
    signature: bytes.subarray(64),
  };
}

/**
 * WHAT THIS NODE SAYS THE ROUND OWES, computed from its own inputs.
 *
 * `entries` carry the core's outcome word, the score and the stake - the same
 * three §20 calls Membership and FinalResults - and the floor comes off the
 * contract rather than a literal, and the payout rule off the round's game (plugins.js payoutRuleOfRound):
 * `payoutShares` its top split, or null for §18A's curve.
 */
export function tableFor({ roundId, entries, minScore, payoutShares = null }) {
  const computed = computePayoutTable({ roundId, entries, minScore, payoutShares });
  const table = computed.table;
  const id = payoutTableId({ roundId, table });
  return { table, tableId: id, bytes: encodePayoutTable({ roundId, table }), computed };
}

/** This node's signature over that id, which is the only thing it signs. */
export function signPayoutTable({ tableId, secret, pubkey }) {
  return joinSignedTable({
    nodePubkey: pubkey, tableId, signature: schnorr.sign(tableId, secret),
  });
}

/**
 * COUNT THE SIGNER NODES THAT SIGNED THE TABLE THIS NODE COMPUTED.
 *
 * The assigned list is the census's, exactly as `verifiedFinal` counts results:
 * a key the chain never assigned is a stranger and not a vote, and one signer node
 * cannot become two by signing twice.
 */
export function verifiedTable(records, { contract, signerNodes, tableId }) {
  if (!Array.isArray(signerNodes) || !signerNodes.length)
    return { ok: false, why: 'that round has no assigned committee to count against' };
  let needed;
  try { needed = receiptsNeeded(contract.settlementSlots); }
  catch (err) { return { ok: false, why: err.message }; }

  const joined = new Set(signerNodes.map(toHex));
  const seen = new Set();
  let agreed = 0, strangers = 0, doubled = 0, forged = 0, other = 0;

  for (const rec of records || []) {
    const bytes = rec instanceof Uint8Array ? rec : rec && rec.bytes;
    let split;
    try { split = splitSignedTable(bytes); } catch { forged++; continue; }
    const who = toHex(split.nodePubkey);
    if (!joined.has(who)) { strangers++; continue; }
    if (seen.has(who)) { doubled++; continue; }
    seen.add(who);

    let ok = false;
    try { ok = schnorr.verify(split.signature, split.tableId, split.nodePubkey); }
    catch { ok = false; }
    if (!ok) { forged++; continue; }

    // A SIGNATURE OVER ANOTHER TABLE IS NOT A VOTE FOR THIS ONE. It is counted
    // separately rather than dropped, because a round where signer nodes sign two
    // different tables is a disagreement an operator has to see.
    if (toHex(split.tableId) !== toHex(tableId)) { other++; continue; }
    agreed++;
  }

  return {
    ok: true,
    final: agreed >= needed,
    agreed, needed, strangers, doubled, forged, signedSomethingElse: other,
    why: agreed >= needed
      ? `${agreed} of ${needed} signer nodes signed this table`
      : `${agreed} of ${needed} signer nodes signed this table, so nothing is spent`,
  };
}
