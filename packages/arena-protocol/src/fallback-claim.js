// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE FALLBACK CLAIM: A STALLED SETTLEMENT RETURNS NOTHING (spec §23.2, RULED 2026-11-07 kanban #1268, REVISED #1290 / #1315; kanban #1281).
// An Arena lock (arena-lock.js) has a third way out: from `fallback_after` (the lock's count plus stall_blocks) until its expiration, t - 1 of
// the n named seats claim it without the preimage. What they may claim it for is fixed here, so every seat, a regtest and an auditor read it alike:
//
//   WHEN      fallbackOpen: from fallback_after until expiration (from expiration only the player's refund is left)
//   WHO FILES any of the four, in a turn by a hash of the round id and its key (fallbackTurnOrder / fallbackFiler): the round's seats ordered by
//             tagged_hash("ARENA/v1/FallbackTurn", round_id || seat key), one block each from fallback_after - the same MuSig2 batch the claim uses
//             (the lowest t - 1 committed sign: arena-lock.js namedSignerSet with threshold - 1)
//   WHAT      the settlement the round's rules make, rebuilt from the entries' FINAL results (fallbackEntries): an entry with no FINAL by then is
//             paid by its result only when four of the seven seats signed one PlayerResult for it; below four it is what the seats wrote (VOID,
//             ENTRY_VOID: the stake back). Nobody replays at the fallback.
//   NODE ROW  only the seats whose signed result or FINAL for the round reached the relays by final_after + 60 s (fallbackEligible); the rest of
//             the fee goes to the reserves - nodeFeeTable's `eligible`, with the unpaid share named, never anyone's income.
//
// Pure: the inputs are already verified (signatures checked by the caller, as every other table input is).
import { taggedHash, toHex } from './hash.js';

/** Signatures on one PlayerResult that let an entry with no FINAL be paid by it at the fallback (§23.2): four of the seven. */
export const FALLBACK_RESULT_SIGNERS = 4;
/** How late a seat's signed result or FINAL may reach the relays and still earn the fallback's node row: final_after + 60 s. */
export const FALLBACK_NODE_GRACE_MS = 60000;
export const FALLBACK_TURN_TAG = 'ARENA/v1/FallbackTurn';

/** Is the fallback open at the guardians' count `count` for a lock `{ fallbackAfter, expiration }`? */
export const fallbackOpen = (lock, count) => Number.isInteger(count) && lock && count >= Number(lock.fallbackAfter) && count < Number(lock.expiration);

/** THE FILING ORDER: the round's seat indices, by tagged_hash("ARENA/v1/FallbackTurn", round_id || seat key) ascending. */
export function fallbackTurnOrder(roundId, seatKeys) {
  if (!(roundId instanceof Uint8Array) || roundId.length !== 32) throw new Error('a round id is 32 bytes');
  const keyed = (seatKeys || []).map((k, i) => {
    if (!(k instanceof Uint8Array) || k.length !== 32) throw new Error('a seat key is 32 bytes');
    const msg = new Uint8Array(64); msg.set(roundId, 0); msg.set(k, 32);
    return { i, h: toHex(taggedHash(FALLBACK_TURN_TAG, msg)) };
  });
  return keyed.sort((a, b) => (a.h < b.h ? -1 : a.h > b.h ? 1 : a.i - b.i)).map((x) => x.i);
}

/** WHOSE TURN TO FILE at `height`: the seat index, one block each in fallbackTurnOrder from fallback_after; null before it. */
export function fallbackFiler({ roundId, seatKeys, fallbackAfter, height }) {
  if (!Number.isInteger(height) || !Number.isInteger(fallbackAfter) || height < fallbackAfter) return null;
  const order = fallbackTurnOrder(roundId, seatKeys);
  return order.length ? order[(height - fallbackAfter) % order.length] : null;
}

/**
 * WHAT EACH ENTRY IS PAID BY AT THE FALLBACK. `entries`: each { entryId, outcome (what the seats wrote), final: { outcome, score } | null,
 * signedResults: [{ seat, resultId, outcome, score }] } - the FINAL the relays hold, and the PlayerResults signed for it, each by the seat index
 * that signed it (verified by the caller). Answers the entries with `outcome` and `score` as the table reads them, and `by`: 'final' |
 * 'four signatures' | 'as written'.
 */
export function fallbackEntries(entries) {
  return (entries || []).map((e) => {
    if (e.final) return { ...e, outcome: e.final.outcome, score: e.final.score, by: 'final' };
    const bySeats = new Map();                 // resultId -> { seats: Set, result }
    for (const r of e.signedResults || []) {
      if (!Number.isInteger(r.seat) || !r.resultId) continue;
      const k = String(r.resultId);
      if (!bySeats.has(k)) bySeats.set(k, { seats: new Set(), result: r });
      bySeats.get(k).seats.add(r.seat);
    }
    // one result four seats signed; two results with four each cannot both be the entry's: then neither is taken
    const four = [...bySeats.values()].filter((x) => x.seats.size >= FALLBACK_RESULT_SIGNERS);
    if (four.length === 1) return { ...e, outcome: four[0].result.outcome, score: four[0].result.score, by: 'four signatures' };
    return { ...e, by: 'as written' };
  });
}

/**
 * THE FALLBACK'S NODE ROW: the seats (hex node keys) whose signed result or FINAL for the round reached the relays by final_after + 60 s.
 * `seenAtMs`: Map(seat hex -> the earliest time the relays held one of its signed results or FINALs for the round). Answers the Set
 * nodeFeeTable takes as `eligible`.
 */
export function fallbackEligible({ seats, seenAtMs, finalAfterMs }) {
  const by = Number(finalAfterMs) + FALLBACK_NODE_GRACE_MS;
  const out = new Set();
  for (const k of seats || []) {
    const h = typeof k === 'string' ? k.toLowerCase() : toHex(k);
    const t = seenAtMs && seenAtMs.get(h);
    if (Number.isFinite(t) && t <= by) out.add(h);
  }
  return out;
}
