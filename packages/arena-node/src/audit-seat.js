// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A SEAT'S DESK FOR AUDITS (spec §13A.1, kanban #725, protocol 22): POST /audit takes an auditor's signed AUDIT of a round when it stands
// (auditor.js auditStands: signed, its VRF proof good, the node eligible and drawn, the round's results the ones this seat holds) and was
// taken in time - signed within AUDIT_TOLERANCE_MS of this seat's clock and at least AUDIT_LEAD_MS before the window closes, or forwarded by
// another seat by the close. One per node and round, kept in the store, so the auditors' lines of the payout read the same set after a
// restart. `contextFor(roundId)` is the seat's: { ok, eligible, total, closeMs, resultsHash } or { ok: false, why }.
import { decodeAudit, auditStands, AUDIT_TOLERANCE_MS } from '../../arena-protocol/src/auditor.js';
import { toHex } from '../../arena-protocol/src/hash.js';

export function createAuditDesk({ db, now = () => Date.now(), contextFor, vrf, verify }) {
  db.exec(`CREATE TABLE IF NOT EXISTS audits (
    round_id BLOB NOT NULL, node BLOB NOT NULL, bytes BLOB NOT NULL, signature BLOB NOT NULL, at_ms INTEGER NOT NULL, arrived_ms INTEGER NOT NULL,
    PRIMARY KEY (round_id, node))`);
  const insert = db.prepare('INSERT OR IGNORE INTO audits (round_id, node, bytes, signature, at_ms, arrived_ms) VALUES (?, ?, ?, ?, ?, ?)');
  const rows = db.prepare('SELECT node, at_ms, arrived_ms FROM audits WHERE round_id = ? ORDER BY node');

  /** An AUDIT as posted: its bytes and the node's 64-byte signature after them. Answers { ok, kept, round, node } or { ok: false, why }. */
  async function take(body, { forwarded = false } = {}) {
    const arrived = now();
    if (!(body instanceof Uint8Array) || body.length <= 64) return { ok: false, status: 400, why: 'an AUDIT is posted as its bytes and its 64-byte signature' };
    const bytes = body.subarray(0, body.length - 64), signature = body.subarray(body.length - 64);
    let a;
    try { a = decodeAudit(bytes); } catch (e) { return { ok: false, status: 400, why: `that is not an AUDIT: ${e.message}` }; }
    const ctx = await contextFor(a.roundId);
    if (!ctx || !ctx.ok) return { ok: false, status: 409, why: (ctx && ctx.why) || 'this seat holds nothing to check that AUDIT against' };
    if (BigInt(arrived) > BigInt(ctx.closeMs)) return { ok: false, status: 409, why: 'the round\'s window has closed: an AUDIT counts only before it' };
    if (!forwarded) {
      const d = a.atMs - BigInt(arrived);
      if ((d < 0n ? -d : d) > BigInt(AUDIT_TOLERANCE_MS)) return { ok: false, status: 409, why: `an AUDIT's signed time is within ${AUDIT_TOLERANCE_MS / 1000} s of the seat's clock (§13A rule 3)` };
    }
    const st = auditStands(a, { signature, vrf, verify, eligible: ctx.eligible, total: ctx.total, resultsHash: ctx.resultsHash, windowCloseMs: ctx.closeMs });
    if (!st.ok) return { ok: false, status: 409, why: st.why };
    const r = insert.run(a.roundId, a.nodePubkey, bytes, signature, Number(a.atMs), arrived);
    return { ok: true, kept: r.changes > 0, round: toHex(a.roundId), node: toHex(a.nodePubkey), body };
  }

  /** The auditors of a round whose AUDIT this seat holds, node keys hex in order - the auditors' lines of its payout. */
  const held = (roundId) => rows.all(roundId).map((r) => toHex(new Uint8Array(r.node)));
  /** What GET /audits answers. */
  const list = (roundId) => rows.all(roundId).map((r) => ({ node: toHex(new Uint8Array(r.node)), atMs: Number(r.at_ms), arrivedMs: Number(r.arrived_ms) }));
  return { take, held, list };
}
