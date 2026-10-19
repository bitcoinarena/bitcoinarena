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
/** A move's id: one per (drained federation, destination) - X drains once. */
export const moveIdOf = (from, to) => toHex(taggedHash('ARENA/v1/ReserveMove', Uint8Array.from([...fromHex(from), ...fromHex(to)])));
/** The encryption seed of the destination's incoming contract: the move's own, so every seat rebuilds the same contract. */
export const moveSeedOf = (moveIdHex) => taggedHash('ARENA/v1/ReserveMoveSeed', utf8(String(moveIdHex)));

/**
 * THE MOVES THESE RECORDS CALL FOR. `feds` [{ id (hex), status ('OPEN' | 'DRAINING' | 'CRITICAL' | 'HALTED' | 'CLOSED'), height (of the
 * newest record), successor (hex or null), key (hex or null: its reserve key), unspentMsat (BigInt) }]. Answers { moves: [{ id, from,
 * to, toKey, fromKey, decidableAt }], waiting: [{ federation, why }] } - a federation that is draining with reserves either moves or says
 * why it waits.
 */
export function moveTargets(feds) {
  const byId = new Map(feds.map((f) => [String(f.id).toLowerCase(), f]));
  const open = feds.filter((f) => f.status === 'OPEN' && f.key).map((f) => String(f.id).toLowerCase()).sort();
  const moves = [], waiting = [];
  for (const f of [...feds].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const from = String(f.id).toLowerCase();
    if (!(BigInt(f.unspentMsat || 0n) > 0n)) continue;
    if (f.status === 'HALTED') { waiting.push({ federation: from, why: 'halted: its notes are frozen until it recovers' }); continue; }
    if (f.status !== 'DRAINING' && f.status !== 'CRITICAL') continue;
    if (!f.key) { waiting.push({ federation: from, why: 'no reserve key is known for it here' }); continue; }
    const succ = f.successor ? String(f.successor).toLowerCase() : null;
    const s = succ && byId.get(succ);
    const to = s && s.status === 'OPEN' && s.key ? succ : open.find((x) => x !== from) || null;
    if (!to) { waiting.push({ federation: from, why: 'no healthy federation to move its reserves to' }); continue; }
    moves.push({ id: moveIdOf(from, to), from, to, fromKey: String(f.key).toLowerCase(), toKey: String(byId.get(to).key).toLowerCase(), decidableAt: Number(f.height) || 0 });
  }
  return { moves, waiting };
}
