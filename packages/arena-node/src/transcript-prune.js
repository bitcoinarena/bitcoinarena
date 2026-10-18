// TRANSCRIPTS LEAVE WITH THEIR CLAIM WINDOW (§34, kanban #33 step 4; the owner 2026-10-17: "Transcripts are deleted when the claim window
// ends, as §34 reads - not kept longer"). §34: "transcripts must be retained through the objection and claim windows by all seven
// nodes". Measured 2026-10-18 on seat 1: 447,137 tick rows (43.7 MB), 66,501 batches (25.0 MB) and 4,498 checkpoints (1.7 MB) over
// 246 rounds, none ever deleted.
//
// A round's transcript - its `ticks`, `batches` and `checkpoints` - is kept until the latest of its entry close and its close on this
// seat, plus its objection window W, plus its contract's claim_window_days; after that it is deleted. A contract that names no claim
// window (no rules block) keeps its transcript: there is no window to end. The round itself, its entries, receipts and results stay.
import { decodeRoundContract } from '../../arena-protocol/src/contracts.js';

export const DAY_MS = 86400000;
/** How often a seat looks (an hour: the windows are a day long). */
export const PRUNE_EVERY_MS = 3600000;

/**
 * Until when a round's transcript is kept, in ms: max(entry close, closed on this seat) + W + claim_window_days; null when the
 * contract names no claim window.
 */
export function transcriptKeptUntil(contract, closedMs = 0) {
  const days = contract && contract.rules ? contract.rules.claimWindowDays : null;
  if (!Number.isInteger(days)) return null;
  return Math.max(Number(contract.entryCloseMs), Number(closedMs || 0)) + Number(contract.objectionWindowMs) + days * DAY_MS;
}

/**
 * Delete the transcripts whose claim window has ended. `keptUntil(row)` answers a rounds row's deadline (default: its contract's,
 * above). Answers { pruned: [round ids hex], kept, rows } - rows deleted over the three tables.
 */
export function pruneTranscripts({ db, nowMs = Date.now(), keptUntil = (row) => transcriptKeptUntil(decodeRoundContract(new Uint8Array(row.contract)), row.closed_ms) }) {
  const ids = db.prepare('SELECT round_id FROM ticks GROUP BY round_id UNION SELECT round_id FROM batches GROUP BY round_id UNION SELECT round_id FROM checkpoints GROUP BY round_id').all();
  const roundOf = db.prepare('SELECT contract, closed_ms FROM rounds WHERE round_id = ?');
  const del = ['ticks', 'batches', 'checkpoints'].map((t) => db.prepare(`DELETE FROM ${t} WHERE round_id = ?`));
  const pruned = []; let kept = 0, rows = 0;
  for (const { round_id: rid } of ids) {
    const row = roundOf.get(rid);
    let until = null;
    try { until = row ? keptUntil(row) : null; } catch { until = null; }
    if (until === null || nowMs < until) { kept += 1; continue; }
    for (const d of del) rows += Number(d.run(rid).changes);
    pruned.push(Buffer.from(rid).toString('hex'));
  }
  return { pruned, kept, rows };
}
