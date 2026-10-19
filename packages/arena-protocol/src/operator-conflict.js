// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// PLAYER-NODE SEPARATION AT RUN TIME (§5A.13, kanban #309).
//
// "A selected node may not sign anything for a round in which its operator has an Entry Contract." The slash proof
// (slash.js slashHoldsOnConflict) punishes a node that signed anyway; this file is the rule BEFORE anything is signed, the
// same comparison of what two objects already say:
//
//   - a node's operator is the key its advertisement declares (slash.js operatorKeyOf; a declaration naming no key conflicts
//     with nobody - "defence in depth, not a Sybil control");
//   - a round's operators are each entry's player key and the operator the entry declares it is (§7
//     `operator_id_declaration`, contracts.js OPERATOR_MARKER);
//   - a node whose operator is among them is CONFLICTED: it signs no result, no payout table, takes no part in the settlement
//     and earns no fee share;
//   - "If conflicts reduce a committee below its threshold, the round's affected entries are ENTRY_VOID (refund) rather than
//     settled by a compromised committee": nobody claims a lock, and each returns to its player at expiry.
import { operatorKeyOf } from './slash.js';
import { toHex } from './hash.js';
import { SETTLEMENT_THRESHOLD } from './payout.js';

const hexOf = (k) => (k instanceof Uint8Array ? toHex(k) : String(k || '')).toLowerCase();

/** The operators a round's entries name: each player's own key and the operator it declares (hex set). */
export function roundOperators(entries) {
  const out = new Set();
  for (const e of entries || []) {
    if (!e) continue;
    if (e.playerPubkey instanceof Uint8Array) out.add(hexOf(e.playerPubkey));
    if (e.operatorId instanceof Uint8Array && !e.operatorId.every((b) => b === 0)) out.add(hexOf(e.operatorId));
  }
  return out;
}

/**
 * THE CONFLICTED NODES OF A ROUND. `nodes`: [{ pubkey, advert }] (a census entry, as the roster's committee answers it);
 * `entries`: the round's decoded Entry Contracts. Answers a Map node hex -> the operator hex it shares with a player.
 */
export function conflictedNodes({ nodes, entries }) {
  const ops = roundOperators(entries);
  const out = new Map();
  for (const n of nodes || []) {
    if (!n || !n.pubkey) continue;
    const op = operatorKeyOf(n.advert);
    if (op && ops.has(hexOf(op))) out.set(hexOf(n.pubkey), hexOf(op));
  }
  return out;
}

/**
 * WHO STILL SERVES A COMMITTEE, and whether it is still a committee. `committee`: node keys; `conflicted`: conflictedNodes'
 * map (or a set of hex); `threshold`: the committee's own (threshold.js receiptsNeeded: 5 of 7, 2 of 2). Answers
 * { serving, conflicted: [hex], voids, why } - `voids` true when conflicted nodes leave fewer than `threshold` serving.
 */
export function servingAfterConflicts({ committee, conflicted, threshold = SETTLEMENT_THRESHOLD }) {
  const bad = conflicted instanceof Map ? new Set(conflicted.keys()) : new Set([...(conflicted || [])].map(hexOf));
  const keys = (committee || []).map(hexOf);
  const serving = keys.filter((k) => !bad.has(k));
  const out = keys.filter((k) => bad.has(k));
  // "IF CONFLICTS REDUCE a committee below its threshold": a committee no node of which is conflicted is never voided here
  const voids = out.length > 0 && serving.length < threshold;
  return { serving, conflicted: out, voids,
    why: voids ? `${out.length} of the committee's ${keys.length} nodes are conflicted (their operator plays) and ${serving.length} `
      + `serve, under the threshold of ${threshold}: the round's entries are ENTRY_VOID, refunded (§5A.13)`
      : out.length ? `${out.length} conflicted node${out.length === 1 ? '' : 's'} left out; ${serving.length} serve (§5A.13)` : 'no node is conflicted' };
}

/** Is THIS node conflicted in the round? `advert`: its own advertisement; answers { conflicted, operator, why }. */
export function selfConflict({ advert, entries }) {
  const op = operatorKeyOf(advert);
  if (!op) return { conflicted: false, operator: null, why: 'this node declares no operator key' };
  const h = hexOf(op);
  return roundOperators(entries).has(h)
    ? { conflicted: true, operator: h, why: `this node's operator ${h.slice(0, 16)} plays in the round: it signs nothing for it (§5A.13)` }
    : { conflicted: false, operator: h, why: 'this node\'s operator plays no entry of the round' };
}
