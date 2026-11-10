// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A SEAT'S DESK FOR HEAD-TO-HEAD AUDITS (spec §13A.1, RULED 2026-11-10 kanban #1400, build #1412): POST /h2h-audit takes an auditor's signed H2H_AUDIT
// of a head-to-head round when it stands (h2h-audit.js h2hAuditStands: signed, its VRF proof good and its beta that proof's, the node eligible and
// drawn - five expected - over the results this seat holds) and arrived before the round's 60 s window closed. One per node and round, kept in the
// store, so the window this seat applies (60 s with two, else 600 s) reads the same set after a restart.
//
// `contextFor(roundId)`: { ok, eligible, total, resultsHash, provisionalAtMs } or { ok: false, why } - the seat's own view: who may audit the round,
// the hash over its own agreed per-entry outcomes, and when its PROVISIONALLY_FINAL stood.
import { decodeH2hAudit, h2hAuditStands, h2hFinality } from '../../arena-protocol/src/h2h-audit.js';
import { OBJECTION_WINDOW_H2H_MS } from '../../arena-protocol/src/constants.js';
import { toHex } from '../../arena-protocol/src/hash.js';

export function createH2hAuditDesk({ db, now = () => Date.now(), contextFor, vrf, verify }) {
  db.exec(`CREATE TABLE IF NOT EXISTS h2h_audits (
    round_id BLOB NOT NULL, node BLOB NOT NULL, bytes BLOB NOT NULL, signature BLOB NOT NULL, results_hash BLOB NOT NULL, at_ms INTEGER NOT NULL,
    arrived_ms INTEGER NOT NULL, forwarded INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (round_id, node))`);
  const insert = db.prepare('INSERT OR IGNORE INTO h2h_audits (round_id, node, bytes, signature, results_hash, at_ms, arrived_ms, forwarded) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const rows = db.prepare('SELECT node, bytes, signature, results_hash, at_ms, arrived_ms, forwarded FROM h2h_audits WHERE round_id = ? ORDER BY node');

  /** An H2H_AUDIT as posted: its bytes and the node's 64-byte signature after them. Answers { ok, kept, round, node } or { ok: false, status, why }. */
  async function take(body, { forwarded = false } = {}) {
    const arrived = now();
    if (!(body instanceof Uint8Array) || body.length <= 64) return { ok: false, status: 400, why: 'an H2H_AUDIT is posted as its bytes and its 64-byte signature' };
    const bytes = body.subarray(0, body.length - 64), signature = body.subarray(body.length - 64);
    let a;
    try { a = decodeH2hAudit(bytes); } catch (e) { return { ok: false, status: 400, why: `that is not an H2H_AUDIT: ${e.message}` }; }
    const ctx = await contextFor(a.roundId);
    if (!ctx || !ctx.ok) return { ok: false, status: 409, why: (ctx && ctx.why) || 'this seat holds nothing to check that H2H_AUDIT against' };
    const closeMs = BigInt(ctx.provisionalAtMs) + OBJECTION_WINDOW_H2H_MS;
    if (BigInt(arrived) > closeMs) return { ok: false, status: 409, why: 'the round\'s 60 s window has closed: an H2H_AUDIT counts only before it (the round finishes on the 600 s window)' };
    const st = h2hAuditStands(a, { signature, vrf, verify, eligible: ctx.eligible, total: ctx.total, resultsHash: ctx.resultsHash, windowCloseMs: closeMs });
    if (!st.ok) return { ok: false, status: 409, why: st.why };
    const r = insert.run(a.roundId, a.nodePubkey, bytes, signature, a.resultsHash, Number(a.atMs), arrived, forwarded ? 1 : 0);
    return { ok: true, kept: r.changes > 0, round: toHex(a.roundId), node: toHex(a.nodePubkey), body };
  }

  /** The H2H_AUDITs held for a round, as h2hFinality reads them. */
  const held = (roundId) => rows.all(roundId).map((r) => ({ nodePubkey: new Uint8Array(r.node), resultsHash: new Uint8Array(r.results_hash), heldAtMs: BigInt(r.arrived_ms) }));
  /** What GET /h2h-audits answers. */
  const list = (roundId) => rows.all(roundId).map((r) => ({ node: toHex(new Uint8Array(r.node)), atMs: Number(r.at_ms), arrivedMs: Number(r.arrived_ms), forwarded: !!r.forwarded,
    audit: toHex(new Uint8Array(r.bytes)) + toHex(new Uint8Array(r.signature)) }));
  /**
   * THE WINDOW THIS SEAT APPLIES to a head-to-head round with the short window: 60 s when two distinct drawn auditors' H2H_AUDITs over its results
   * hash arrived in time, else 600 s (never VOID for want of auditors). `committeeFinal`: whether the committee's 5 of 7 stands.
   */
  async function windowOf(roundId, { committeeFinal = true } = {}) {
    const ctx = await contextFor(roundId);
    if (!ctx || !ctx.ok) return { ok: false, why: (ctx && ctx.why) || 'no context for that round' };
    const f = h2hFinality({ provisionalAtMs: ctx.provisionalAtMs, committeeFinal, audits: held(roundId), resultsHash: ctx.resultsHash, nowMs: now() });
    return { ok: true, ...f };
  }
  return { take, held, list, windowOf };
}
