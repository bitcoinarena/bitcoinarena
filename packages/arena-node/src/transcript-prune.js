// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// TRANSCRIPTS LEAVE WITH THEIR CLAIM WINDOW (§342026-10-17: "Transcripts are deleted when the claim window
// ends, as §34 reads - not kept longer"). §34: "transcripts must be retained through the objection and claim windows by all seven
// nodes". Measured 2026-10-18 on seat 1: 447,137 tick rows (43.7 MB), 66,501 batches (25.0 MB) and 4,498 checkpoints (1.7 MB) over
// 246 rounds, none ever deleted.
//
// A round's transcript - its `ticks`, `batches` and `checkpoints` - is kept until the latest of its entry close and its close on this
// seat, plus its objection window W, plus its contract's claim_window_days; after that it is deleted. A contract that names no claim
// window (no rules block) keeps its transcript: there is no window to end. The round itself, its entries, receipts and results stay.
import { decodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { roundEndMs } from '../../arena-protocol/src/first-mark.js';
import { toHex } from '../../arena-protocol/src/hash.js';

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

// RELAYED TRANSCRIPTS LEAVE WITH THEM (kanban #1532): a transcript this seat keeps as a publication relay (PUT /transcript, the
// `relayed` table) goes when its round's claim window has ended, as the round's own transcript does. Its round is read from the
// bytes the door took: a transcript names it (type 0x09, version, round id), a head-to-head reveal record (33 or 65 bytes) names an
// entry this seat holds. Slash proofs and rows of no round: see below (kanban #1917).
//
// A RELAYED COPY IS NEVER KEPT FOR EVER (kanban #1725, #1795, refute of #1532): a round whose contract names no claim window (no rules
// block - the duty poster's DUTY_TEMPLATE) keeps its own transcript, but the copies the relay door took for it go RELAY_NO_WINDOW_DAYS
// after max(entry close, close here) + W; a copy whose round this seat no longer holds, or whose contract it cannot read, goes
// RELAY_NO_WINDOW_DAYS after the door took it (seen_ms). Otherwise one entry's junk in such a round kept the relay pool full for good.
//
// SLASH PROOFS AND UNKNOWN ROWS GO TOO (kanban #1917, refute 2 of #1532): a relayed slash proof names its round (the `round_id` column
// the slash door writes, or the proof's own bytes for a row from before) and goes with that round's claim window like its
// transcripts; a row whose round is read from nowhere goes RELAY_NO_WINDOW_DAYS after the door took it. Before, such rows were
// skipped and stayed for good, so a pool once full of them stayed full.
export const RELAY_NO_WINDOW_DAYS = 7;
export function relayedKeptUntil(contract, closedMs = 0) {
  const until = transcriptKeptUntil(contract, closedMs);
  if (until !== null) return until;
  return Math.max(Number(contract.entryCloseMs), Number(closedMs || 0)) + Number(contract.objectionWindowMs) + RELAY_NO_WINDOW_DAYS * DAY_MS;
}
export function pruneRelayed({ db, nowMs = Date.now(), keptUntil = (row) => relayedKeptUntil(decodeRoundContract(new Uint8Array(row.contract)), row.closed_ms) }) {
  const rows = db.prepare(`SELECT hash, seen_ms, CASE WHEN LENGTH(bytes) >= 67 AND SUBSTR(bytes, 1, 1) = x'09' THEN SUBSTR(bytes, 4, 32)
    WHEN LENGTH(bytes) IN (33, 65) THEN (SELECT round_id FROM entries WHERE entry_id = SUBSTR(relayed.bytes, 1, 32))
    WHEN LENGTH(bytes) > 199 AND SUBSTR(bytes, 1, 1) = x'0c' THEN SUBSTR(bytes, 4, 32)
    WHEN LENGTH(bytes) > 206 AND SUBSTR(bytes, 1, 1) = x'43' AND SUBSTR(bytes, 8, 1) = x'0c' THEN SUBSTR(bytes, 11, 32)
    ELSE round_id END AS rid FROM relayed`).all();   // 2.0 (port of #1917): a fraud proof's evidence names its round; else the door's round_id
  const roundOf = db.prepare('SELECT contract, closed_ms FROM rounds WHERE round_id = ?');
  const del = db.prepare('DELETE FROM relayed WHERE hash = ?');
  const untilOf = new Map(); let deleted = 0;
  const lastly = (seenMs) => Number(seenMs || 0) + RELAY_NO_WINDOW_DAYS * DAY_MS;
  for (const { hash, rid, seen_ms: seenMs } of rows) {
    if (!rid) { if (nowMs >= lastly(seenMs)) deleted += Number(del.run(hash).changes); continue; }   // kanban #1917: never kept for good
    const k = Buffer.from(rid).toString('hex');
    if (!untilOf.has(k)) {
      const row = roundOf.get(rid);
      let until = null;
      try { until = row ? keptUntil(row) : null; } catch { until = null; }
      untilOf.set(k, until);
    }
    const u = untilOf.get(k), until = Number.isFinite(u) ? u : lastly(seenMs);
    if (nowMs < until) continue;
    deleted += Number(del.run(hash).changes);
  }
  return { deleted };
}

// ROUNDS NOBODY USED LEAVE TOO (2026-10-18: "optimise cpu usage and space on nodes ... Make it lean"). Measured on
// seat 2: 272,857 rounds (233 MB of contracts) of which 316 ever had an entry; their committee and seating records - 1,803,671
// signer_nodes rows, 820,816 seat_presents, 460,725 seat_sigs, 265,768 round_beacons, 106,637 seat_certs - were never deleted, every
// start decoded all 272k contracts (server.js, the posted rounds re-read) and the seating agent held every certificate in memory.
//
// A round is UNUSED when no table outside its committee and seating set holds a row for it: no entry, lock, result, posting, market
// order, outcome, objection, forfeit, equivocation - whatever table a seat keeps per round, found from the schema, so a table added
// later counts by itself. An unused round goes, with every committee and seating row, once its end + W + its claim window has
// passed (a day where it names none). A used round is never touched here.
// `round_peers`: the seated nodes' addresses kept with the round (kanban #735) - a seating record, gone with the round
export const COMMITTEE_TABLES = Object.freeze(['rounds', 'signer_nodes', 'round_beacons', 'seat_presents', 'seat_sigs', 'seat_certs', 'seat_signed', 'seat_presigs', 'round_peers',
  // a seating's seated list and the members left for withholding (kanban #1509, #2140): seating rows, never a mark of use
  'seat_seatings', 'seat_withheld']);
const TRANSCRIPT_TABLES = ['ticks', 'batches', 'checkpoints'];
/** At most this many rounds looked at in one pass: the backlog goes in steps, never one long stall of the seat. */
export const UNUSED_BATCH = 5000;
/** An unreadable round's keep after it was stored: a week, far past any window a readable one has. */
export const UNREADABLE_KEEP_MS = 7 * DAY_MS;

/** When an unused round may go, in ms: its end (roundEndMs, else entry close) + W + its claim window (a day where none is named). */
export function unusedRoundGoesAt(contract, endMs) {
  const days = contract && contract.rules && Number.isInteger(contract.rules.claimWindowDays) ? contract.rules.claimWindowDays : 1;
  return Number(endMs) + Number(contract.objectionWindowMs) + days * DAY_MS;
}

/** The tables that mark a round used: every table with a round_id column outside the committee, seating and transcript tables. */
export function usedMarkerTables(db) {
  const skip = new Set([...COMMITTEE_TABLES, ...TRANSCRIPT_TABLES]);
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name)
    .filter((t) => !skip.has(t) && /^[a-z_0-9]+$/.test(t) && db.prepare(`PRAGMA table_info(${t})`).all().some((c) => c.name === 'round_id'));
}

/**
 * One pass over at most `batch` rounds after rowid `afterRowid`: the unused ones past their time are deleted with their committee
 * and seating rows. `goesAt(row)` answers a rounds row's time (default: its contract's). Answers { deleted, rows, looked, lastRowid,
 * done } - done when the pass reached the table's end; the next pass starts from 0 again.
 */
// `contractOf(round_id)`: the seat's decoded contract (Round.contractOf, kept while the round is open - kanban #742), or null where it
// does not parse; unnamed, each row's contract is decoded here.
export function pruneUnusedRounds({ db, nowMs = Date.now(), afterRowid = 0, batch = UNUSED_BATCH, goesAt = null, contractOf = null, onDeleted = () => {} }) {
  // A CONTRACT THIS SEAT CANNOT READ (measured on test host seat 1: its oldest 3,000 rounds, stored 2026-09-28, all fail with "custody
  // byte 94 is not a custody of this network" - an older format) can be neither served nor settled by it: it goes UNREADABLE_KEEP_MS
  // after it was stored, still only when nothing marks it used
  const at = goesAt || ((row) => {
    let c; try { c = contractOf ? contractOf(row.round_id) : decodeRoundContract(new Uint8Array(row.contract)); } catch { c = null; }
    if (!c) return Number(row.opened_ms) + UNREADABLE_KEEP_MS;
    let end; try { end = Number(roundEndMs(c)); } catch { end = Number(c.entryCloseMs); } return unusedRoundGoesAt(c, end); });
  // THE USED IDS READ ONCE PER PASS (kanban #705, profiled on test host seat 4 2026-10-26 12:55Z: 90 % of its loop, the seat silent for
  // minutes): a lookup per round and marker table was a full scan of each of the 17 tables without a round_id index - 17,000 scans a
  // pass. Keyed as SQLite compares them: a text id never equals a blob one.
  const idKey = (v) => (typeof v === 'string' ? `s${v}` : v instanceof Uint8Array ? `b${toHex(v)}` : `o${String(v)}`);
  const used = new Set();
  for (const t of usedMarkerTables(db)) for (const u of db.prepare(`SELECT DISTINCT round_id FROM ${t}`).iterate()) used.add(idKey(u.round_id));
  const present = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
  const dels = [...COMMITTEE_TABLES.filter((t) => t !== 'rounds' && present.has(t)), ...TRANSCRIPT_TABLES.filter((t) => present.has(t)), 'rounds']
    .map((t) => db.prepare(`DELETE FROM ${t} WHERE round_id = ?`));
  const rowsOf = db.prepare('SELECT rowid, round_id, contract, opened_ms FROM rounds WHERE rowid > ? ORDER BY rowid LIMIT ?').all(afterRowid, batch);
  let deleted = 0, rows = 0, lastRowid = afterRowid;
  db.exec('BEGIN');
  try {
    for (const r of rowsOf) {
      lastRowid = r.rowid;
      // a used round is kept whatever its time: asked first, so its contract is not decoded for nothing (kanban #742)
      if (used.has(idKey(r.round_id))) continue;
      let when; try { when = at(r); } catch { continue; }
      if (!(nowMs >= when)) continue;
      for (const d of dels) rows += Number(d.run(r.round_id).changes);
      deleted += 1; onDeleted(r.round_id);
    }
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch { /* none open */ } throw e; }
  return { deleted, rows, looked: rowsOf.length, lastRowid, done: rowsOf.length < batch };
}
