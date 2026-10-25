// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// EVERY ORDER'S TRANSACTION, KEPT AT THE SEAT (kanban #624, 2026-10-24: "each order that was executed gets a transaction id in upordown
// and in the account history. They point to explorer.bitcoin-arena.io which records all transactions ... Also records the timing info we
// already display there and all relevant data"; "In the logs we need the txid too so tracing delays is 100% possible"). A transaction's id is
// its entry id - the hash of the entry contract, the same at every seat. Kept per id:
//
//   steps        each door the transaction passed at this seat (handout, entry, lock, fee-lock): arrival (UTC ms), each step's
//                offset, the answer's status and the whole time - the [steps] lines of step-log.js, as rows. A handout is kept under its
//                own id; the entry names it (vssSharesRef), so GET /tx joins the two.
//   round        what this seat did to settle the transaction's round (2026-10-24: "Also show who processed the round, e.g for
//                settlement and verify"): committed to its settlement, gave its signature share, combined it, took it from a peer,
//                saw it accepted - each with its time; GET /tx names the committees and the outcome's attestors beside them.
//   client       the page's own timings of the order (from the press: submitted, placed, lock, and its steps before the lock), handed
//                over by the page and signed with the order's session key, so no one but the player's page writes them.
//
// Rows older than KEEP_MS go; a transaction's entry, locks and settlement stay where the seat keeps them anyway.
import { createHash } from 'node:crypto';

export const KEEP_MS = 14 * 24 * 3600 * 1000;
export const TIMING_TAG = 'arena/tx-timing/v1';
const MAX_TIMING_BYTES = 8000;

/** The bytes a page signs over its timing: the tag, the transaction id and the timing's JSON, hashed. */
export function timingMessage(idHex, timingJson) {
  return createHash('sha256').update(`${TIMING_TAG}\n${String(idHex).toLowerCase()}\n${timingJson}`).digest();
}

export function createTxRecord({ db, now = () => Date.now() }) {
  db.exec(`CREATE TABLE IF NOT EXISTS tx_steps (
    id     TEXT NOT NULL,
    kind   TEXT NOT NULL,
    at_ms  INTEGER NOT NULL,
    steps  TEXT NOT NULL,
    status INTEGER,
    ms     INTEGER,
    PRIMARY KEY (id, kind, at_ms)
  );
  CREATE TABLE IF NOT EXISTS tx_round_events (
    round   TEXT NOT NULL,
    at_ms   INTEGER NOT NULL,
    what    TEXT NOT NULL,
    detail  TEXT,
    PRIMARY KEY (round, at_ms, what)
  );
  CREATE TABLE IF NOT EXISTS tx_client_timing (
    id       TEXT PRIMARY KEY,
    timing   TEXT NOT NULL,
    kept_ms  INTEGER NOT NULL
  );`);
  const put = db.prepare('INSERT OR REPLACE INTO tx_steps (id, kind, at_ms, steps, status, ms) VALUES (?, ?, ?, ?, ?, ?)');
  const of = db.prepare('SELECT id, kind, at_ms, steps, status, ms FROM tx_steps WHERE id = ? ORDER BY at_ms');
  const putTiming = db.prepare('INSERT OR REPLACE INTO tx_client_timing (id, timing, kept_ms) VALUES (?, ?, ?)');
  const timingOf = db.prepare('SELECT timing, kept_ms FROM tx_client_timing WHERE id = ?');
  const putRound = db.prepare('INSERT OR IGNORE INTO tx_round_events (round, at_ms, what, detail) VALUES (?, ?, ?, ?)');
  const roundOf = db.prepare('SELECT at_ms, what, detail FROM tx_round_events WHERE round = ? ORDER BY at_ms');
  const lastOf = db.prepare('SELECT what FROM tx_round_events WHERE round = ? ORDER BY at_ms DESC LIMIT 1');
  let pruned = 0;
  const prune = () => {
    if (now() - pruned < 3600000) return;
    pruned = now();
    db.prepare('DELETE FROM tx_steps WHERE at_ms < ?').run(now() - KEEP_MS);
    db.prepare('DELETE FROM tx_client_timing WHERE kept_ms < ?').run(now() - KEEP_MS);
    db.prepare('DELETE FROM tx_round_events WHERE at_ms < ?').run(now() - KEEP_MS);
  };
  return {
    /** step-log.js's `keep`: one door's line, as a row - only a request that named its transaction. */
    keep({ kind, id, t0, steps, status, ms }) {
      if (!/^[0-9a-f]{64}$/.test(String(id))) return;
      try { put.run(String(id), String(kind), Number(t0), JSON.stringify(steps), Number(status) || null, Number(ms) || null); prune(); } catch { /* the log line stands */ }
    },
    /** Every door a transaction passed here, oldest first: [{ door, atMs, at, steps, status, ms }]. */
    steps(ids) {
      const out = [];
      for (const id of ids.filter((x) => /^[0-9a-f]{64}$/.test(String(x)))) {
        for (const r of of.all(String(id))) out.push({ door: r.kind, atMs: Number(r.at_ms), at: new Date(Number(r.at_ms)).toISOString(), steps: JSON.parse(r.steps), status: r.status, ms: r.ms });
      }
      return out.sort((a, b) => a.atMs - b.atMs);
    },
    /** One thing this seat did to settle a round; the same thing said again in a row is kept once (a settle asked again). */
    keepRound({ round, what, detail = null }) {
      if (!/^[0-9a-f]{64}$/.test(String(round))) return;
      try {
        const last = lastOf.get(String(round));
        if (last && last.what === String(what)) return;
        putRound.run(String(round), now(), String(what), detail === null ? null : String(detail).slice(0, 300)); prune();
      } catch { /* the log stands */ }
    },
    /** What this seat did to settle a round, oldest first: [{ at, atMs, what, detail }]. */
    roundEvents(round) {
      return roundOf.all(String(round)).map((r) => ({ atMs: Number(r.at_ms), at: new Date(Number(r.at_ms)).toISOString(), what: r.what, detail: r.detail }));
    },
    /** The page's timing, kept once its signature stands (the caller checks it). */
    keepClientTiming(id, timingJson) {
      if (String(timingJson).length > MAX_TIMING_BYTES) return { ok: false, why: `a timing is at most ${MAX_TIMING_BYTES} bytes` };
      putTiming.run(String(id), String(timingJson), now());
      return { ok: true };
    },
    clientTiming(id) {
      const r = timingOf.get(String(id));
      if (!r) return null;
      try { return { ...JSON.parse(r.timing), keptAt: new Date(Number(r.kept_ms)).toISOString() }; } catch { return null; }
    },
  };
}
