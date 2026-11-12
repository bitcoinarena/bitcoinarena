// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE RESERVES OF A DRAINED FEDERATION, MOVED TO A HEALTHY ONE (§27A.9.22026-10-17: "Decision: A" - the move is a
// Lightning payment out of the drained federation's 5-of-7 reserve key into an incoming contract only the destination's 5-of-7 reserve
// key can claim; the accepted sequence:
//   1. Trigger: every seat sees from its own records that federation X is draining and still holds reserves. A halted federation has its
//      funds frozen, so it waits.
//   2. Destination: X's successor if it is open, otherwise the lowest-id open federation that has a reserve key. No healthy federation
//      means no move.
//   3-6: the invoice, the payment, the claim, the record - reserve-payout.js, as a payout of kind 'move'.)
//
// This file is the rule of 1 and 2 and the move's own names, pure: every seat computes the same from the same records.
import { taggedHash, toHex, fromHex } from '../../arena-protocol/src/hash.js';

const utf8 = (s) => new TextEncoder().encode(s);
/** A move's id: one per (drained federation, destination, sequence). Sequence 0 is the first move (its id as before); sequence n the move
 *  after n finished ones (kanban #2435, state audit 2026-11-12: one id per pair let X drain once - a REFUNDED move, or a reserve output
 *  reaching X after its move was CLAIMED, stayed in X for good while moveTargets kept listing it). reserve-payout.js moves under the
 *  lowest sequence whose record is not finished (REFUNDED, SHORT, CLAIMED); each input is still spent once, by the spent set. */
export const moveIdOf = (from, to, seq = 0) => {
  const n = Number(seq) || 0;
  const tail = n > 0 ? [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255] : [];
  return toHex(taggedHash('ARENA/v1/ReserveMove', Uint8Array.from([...fromHex(from), ...fromHex(to), ...tail])));
};
/** The encryption seed of the destination's incoming contract: the move's own, so every seat rebuilds the same contract. */
export const moveSeedOf = (moveIdHex) => taggedHash('ARENA/v1/ReserveMoveSeed', utf8(String(moveIdHex)));
/** The seed of a plan's own invoice: each attempt draws a `seedTag` the plan names, so a second attempt asks for another payment hash
 *  (kanban #326, measured 2026-10-22: one seed per move made one hash, and after a first plan fell through the gateway refused every
 *  later invoice, "PaymentHash is already registered"). A plan without a tag is the first form. */
export const moveSeedFor = (plan) => moveSeedOf(plan && plan.seedTag ? `${plan.proposal}:${plan.seedTag}` : plan.proposal);

/**
 * THE MOVES THESE RECORDS CALL FOR. `feds` [{ id (hex), status ('OPEN' | 'DRAINING' | 'CRITICAL' | 'HALTED' | 'CLOSED'), height (of the
 * newest record), successor (hex or null), key (hex or null: its reserve key), unspentMsat (BigInt) }]. Answers { moves: [{ id, from,
 * to, toKey, fromKey, decidableAt }], waiting: [{ federation, why }] } - a federation that is draining with reserves either moves or says
 * why it waits; so does a closed one that still holds reserves (kanban #1981).
 */
export function moveTargets(feds) {
  const byId = new Map(feds.map((f) => [String(f.id).toLowerCase(), f]));
  const open = feds.filter((f) => f.status === 'OPEN' && f.key).map((f) => String(f.id).toLowerCase()).sort();
  const moves = [], waiting = [];
  for (const f of [...feds].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const from = String(f.id).toLowerCase();
    if (!(BigInt(f.unspentMsat || 0n) > 0n)) continue;
    if (f.status === 'HALTED') { waiting.push({ federation: from, why: 'halted: its notes are frozen until it recovers' }); continue; }
    // A CLOSED federation that still holds reserves moves as a draining one does (kanban #1981): server.js closedOf turns the record
    // CLOSED by the drain clock (DRAIN_MS, no open round naming it), never by the money - a move that waited the whole drain (the
    // successor's reserve key not dealt yet) was dropped without a word, and the reserves stayed there for good. It takes no new money,
    // so its reserves either move or say why they wait.
    if (f.status !== 'DRAINING' && f.status !== 'CRITICAL' && f.status !== 'CLOSED') continue;
    if (!f.key) { waiting.push({ federation: from, why: 'no reserve key is known for it here' }); continue; }
    const succ = f.successor ? String(f.successor).toLowerCase() : null;
    const s = succ && byId.get(succ);
    const to = s && s.status === 'OPEN' && s.key ? succ : open.find((x) => x !== from) || null;
    if (!to) { waiting.push({ federation: from, why: 'no healthy federation to move its reserves to' }); continue; }
    moves.push({ id: moveIdOf(from, to), from, to, fromKey: String(f.key).toLowerCase(), toKey: String(byId.get(to).key).toLowerCase(), decidableAt: Number(f.height) || 0 });
  }
  return { moves, waiting };
}
