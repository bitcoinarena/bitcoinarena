// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE FALLBACK CLAIM'S INPUTS FROM A SEAT'S OWN STORE (spec §23.2, kanban #1281): what fallback-claim.js decides by, read from the tables
// the finality and the stall book already keep - nothing fetched, so every seat that holds the round's data reads the same:
//   an entry's FINAL     entry_finals (kept once reached, never undone): the entry is paid by its outcome as the store decided it
//   signed results       results: each seat's signed PlayerResult for the entry. A result names its signer (node_pubkey), so "four seats signed
//                        ONE PlayerResult" is read by its content - outcome, score, transcript hash, sim core hash - not by its id
//   the node row         the earliest seen_ms of each seat's signed result or FINAL signature for the round (results, final_sigs), against
//                        the round's final_after (window.js windowsOf)
import { fallbackEntries, fallbackEligible } from '../../arena-protocol/src/fallback-claim.js';
import { decodePlayerResult, splitSignedResult } from '../../arena-protocol/src/result.js';
import { windowsOf } from '../../arena-protocol/src/window.js';
import { taggedHash, toHex } from '../../arena-protocol/src/hash.js';

const hexOf = (b) => toHex(new Uint8Array(b));
/** A result's content without its signer: what four seats must agree on. */
export function resultContentId(r) {
  const enc = new TextEncoder().encode(`${r.outcome}|${r.score}|${toHex(r.transcriptHash)}|${toHex(r.simCoreHash)}`);
  return toHex(taggedHash('ARENA/v1/FallbackResultContent', enc));
}

/**
 * `db` the seat's store (node:sqlite), `roundIdBytes`, `contract` (its `nodes`: the seats' keys in seat order), `entries` as entriesOnRecord
 * reads them ({ entryId, pubkey, outcome, score, ... }); `finalAfterMs` the round's final_after when the caller has it (else windowsOf). Answers { entries: fallbackEntries(...), eligible: Set(seat hex), finalAfterMs }.
 */
export function fallbackInputs({ db, roundIdBytes, contract, entries, finalAfterMs = null }) {
  const rid = Buffer.from(roundIdBytes);
  const seatOf = new Map((contract.nodes || []).map((k, i) => [toHex(k), i]));
  const finals = new Set(db.prepare('SELECT entry_id FROM entry_finals WHERE round_id = ?').all(rid).map((r) => hexOf(r.entry_id)));
  const seen = new Map();
  const saw = (k, ms) => { const t = Number(ms); if (!seen.has(k) || t < seen.get(k)) seen.set(k, t); };
  const byEntry = new Map();
  for (const r of db.prepare('SELECT entry_id, node_pubkey, bytes, seen_ms FROM results WHERE round_id = ?').all(rid)) {
    const node = hexOf(r.node_pubkey);
    saw(node, r.seen_ms);
    if (!seatOf.has(node)) continue;
    let res; try { res = decodePlayerResult(splitSignedResult(new Uint8Array(r.bytes)).body); } catch { continue; }
    const e = hexOf(r.entry_id);
    if (!byEntry.has(e)) byEntry.set(e, []);
    byEntry.get(e).push({ seat: seatOf.get(node), resultId: resultContentId(res), outcome: res.outcome, score: res.score });
  }
  for (const r of db.prepare('SELECT signer_pubkey, seen_ms FROM final_sigs WHERE round_id = ?').all(rid)) saw(hexOf(r.signer_pubkey), r.seen_ms);
  const mapped = fallbackEntries((entries || []).map((e) => {
    const k = toHex(e.entryId);
    return { ...e, final: finals.has(k) ? { outcome: e.outcome, score: e.score } : null, signedResults: byEntry.get(k) || [] };
  }));
  const fa = finalAfterMs !== null ? Number(finalAfterMs) : Number(windowsOf(contract).finalAfterMs);
  return { entries: mapped, eligible: fallbackEligible({ seats: contract.nodes || [], seenAtMs: seen, finalAfterMs: fa }), finalAfterMs: fa };
}
