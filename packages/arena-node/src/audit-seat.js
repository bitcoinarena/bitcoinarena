// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A SEAT'S DESK FOR AUDITS (spec §13A.1, kanban #725, protocol 22): POST /audit takes an auditor's signed AUDIT of a round when it stands
// (auditor.js auditStands: signed, its VRF proof good, the node eligible and drawn, the round's results the ones this seat holds) and was
// taken in time - signed within AUDIT_TOLERANCE_MS of this seat's clock and at least AUDIT_LEAD_MS before the window closes, or forwarded by
// another seat by the close. One per node and round, kept in the store, so the auditors' lines of the payout read the same set after a
// restart. `contextFor(roundId)` is the seat's: { ok, eligible, total, closeMs, resultsHash } or { ok: false, why }.
//
// AN AUDIT A VALID OBJECTION CONTRADICTS (§13A.1: "an AUDIT over a result that a valid objection later contradicts is a fraud proof
// against its signer"): `contradict` marks every AUDIT the seat holds for the round - each vouched for the very results the objection
// now contradicts, since a seat takes one only over the results it holds - and keeps its bytes and signature as the evidence. A
// contradicted AUDIT is paid nothing: `held` leaves it out of the auditors' lines. And it is filed for slashing (kanban #724, #725):
// `contradicted` hands its bytes and signature to verify.js fileAuditSlashProofs, which files the AUDIT_CONTRADICTED proof.
import { decodeAudit, auditStands, auditId, auditResultsHash, AUDIT_TOLERANCE_MS } from '../../arena-protocol/src/auditor.js';
import { taggedHash, toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { TAG } from '../../arena-protocol/src/constants.js';
import { verifiedFinal } from './verdict.js';

/** What a seat signs when it hands an AUDIT (its bytes and the auditor's signature) on to the round's other seats. */
export const forwardDigest = (body) => taggedHash(TAG.auditForward, auditId(decodeAudit(body.subarray(0, body.length - 64))));

/**
 * THE RESULTS AN AUDIT VOUCHES FOR, read the same way by a seat and by an auditor (§13A.1): for every entry of the round, the run its
 * committee agreed (verifiedFinal over the signed results: the 5 of 7 of §13A). `entries` [{ entryId (bytes), results: [signed bytes] }].
 * Answers { ok, runs: [{ entryId, runId (bytes) }], resultsHash } - or { ok: false, why } while an entry has no agreed run: an AUDIT is
 * over every entry of the round or not made at all.
 */
export function agreedRunsOf({ contract, committee, entries }) {
  if (!entries || !entries.length) return { ok: false, why: 'the round has no entry to audit' };
  const runs = [];
  for (const e of entries) {
    const seen = verifiedFinal(e.results, { contract, signerNodes: committee });
    if (!seen.ok || !seen.final) return { ok: false, why: `entry ${toHex(e.entryId).slice(0, 16)} has no agreed run yet: ${seen.why}` };
    runs.push({ entryId: e.entryId, runId: fromHex(seen.runId) });
  }
  return { ok: true, runs, resultsHash: auditResultsHash(runs.map((r) => ({ entryId: r.entryId, resultDigest: r.runId }))) };
}

export function createAuditDesk({ db, now = () => Date.now(), contextFor, vrf, verify }) {
  db.exec(`CREATE TABLE IF NOT EXISTS audits (
    round_id BLOB NOT NULL, node BLOB NOT NULL, bytes BLOB NOT NULL, signature BLOB NOT NULL, at_ms INTEGER NOT NULL, arrived_ms INTEGER NOT NULL,
    forwarded INTEGER NOT NULL DEFAULT 0, contradicted TEXT,
    PRIMARY KEY (round_id, node))`);
  // THE OBJECTIONS THIS NODE FILED AS AN AUDITOR (kanban #1002): the owner area counts them; the entry's objection itself stands in `objections` with no filer
  db.exec(`CREATE TABLE IF NOT EXISTS audit_objections (round_id BLOB NOT NULL, entry_id BLOB NOT NULL, taken INTEGER NOT NULL, at_ms INTEGER NOT NULL, PRIMARY KEY (round_id, entry_id))`);
  const insert = db.prepare('INSERT OR IGNORE INTO audits (round_id, node, bytes, signature, at_ms, arrived_ms, forwarded) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const rows = db.prepare('SELECT node, bytes, signature, at_ms, arrived_ms, forwarded, contradicted FROM audits WHERE round_id = ? ORDER BY node');
  const mark = db.prepare('UPDATE audits SET contradicted = ? WHERE round_id = ? AND contradicted IS NULL');

  /** An AUDIT as posted: its bytes and the node's 64-byte signature after them. Answers { ok, kept, round, node } or { ok: false, why }. */
  async function take(body, { forwarded = false, relayedAtMs = null } = {}) {
    // AN AUDIT A RELAY HELD (kanban #1331 (2)): its time is the relay's own arrival time, and it counts when that is before the window's close
    const arrived = relayedAtMs !== null ? Number(relayedAtMs) : now();
    if (!(body instanceof Uint8Array) || body.length <= 64) return { ok: false, status: 400, why: 'an AUDIT is posted as its bytes and its 64-byte signature' };
    const bytes = body.subarray(0, body.length - 64), signature = body.subarray(body.length - 64);
    let a;
    try { a = decodeAudit(bytes); } catch (e) { return { ok: false, status: 400, why: `that is not an AUDIT: ${e.message}` }; }
    const ctx = await contextFor(a.roundId);
    if (!ctx || !ctx.ok) return { ok: false, status: 409, why: (ctx && ctx.why) || 'this seat holds nothing to check that AUDIT against' };
    if (BigInt(arrived) > BigInt(ctx.closeMs)) return { ok: false, status: 409, why: 'the round\'s window has closed: an AUDIT counts only before it' };
    // signed within the tolerance of when it was held: here, or at the relay that held it
    if (!forwarded || relayedAtMs !== null) {
      const d = a.atMs - BigInt(arrived);
      if ((d < 0n ? -d : d) > BigInt(AUDIT_TOLERANCE_MS)) return { ok: false, status: 409, why: `an AUDIT's signed time is within ${AUDIT_TOLERANCE_MS / 1000} s of the seat's clock (§13A rule 3)` };
    }
    const st = auditStands(a, { signature, vrf, verify, eligible: ctx.eligible, total: ctx.total, resultsHash: ctx.resultsHash, windowCloseMs: ctx.closeMs });
    if (!st.ok) return { ok: false, status: 409, why: st.why };
    const r = insert.run(a.roundId, a.nodePubkey, bytes, signature, Number(a.atMs), arrived, forwarded ? 1 : 0);
    return { ok: true, kept: r.changes > 0, round: toHex(a.roundId), node: toHex(a.nodePubkey), body };
  }

  /** The auditors of a round whose AUDIT this seat holds and no valid objection contradicted, node keys hex in order - its payout's lines. */
  const held = (roundId) => rows.all(roundId).filter((r) => r.contradicted === null).map((r) => toHex(new Uint8Array(r.node)));
  /** What GET /audits answers: every AUDIT held, a contradicted one with why and its bytes and signature (the fraud proof's evidence); `full` every one's. */
  const list = (roundId, { full = false } = {}) => rows.all(roundId).map((r) => ({ node: toHex(new Uint8Array(r.node)), atMs: Number(r.at_ms), arrivedMs: Number(r.arrived_ms),
    forwarded: !!r.forwarded, contradicted: r.contradicted,
    ...(full || r.contradicted !== null ? { audit: toHex(new Uint8Array(r.bytes)) + toHex(new Uint8Array(r.signature)) } : {}) }));
  /**
   * THE AUDITS ON THE ROUND'S RELAYS (§13A.1 RULED 2026-11-07, kanban #1306/#1331 (2)): "An AUDIT counts when it is on the round's
   * publication_relays[] by the cutoff, not only when a seat says it holds it." Every relay is a seat door: GET /audits?round=&full=1 at each one,
   * and every AUDIT a relay held directly (not forwarded) before the window's close is taken here at the relay's arrival time - checked as any
   * AUDIT is. Answers { asked, taken }.
   */
  async function fromRelays(roundId, relays, { fetcher = fetch, timeoutMs = 8000 } = {}) {
    let taken = 0, asked = 0;
    for (const relay of relays || []) {
      let j = null;
      try { const r = await fetcher(`${String(relay).replace(/\/+$/, '')}/audits?round=${toHex(roundId)}&full=1`, { signal: AbortSignal.timeout(timeoutMs) }); if (r.ok) j = await r.json(); } catch { j = null; }
      if (!j || !Array.isArray(j.audits)) continue;
      asked += 1;
      for (const x of j.audits) {
        if (!x || x.forwarded || typeof x.audit !== 'string' || !/^[0-9a-f]+$/.test(x.audit) || !Number.isFinite(Number(x.arrivedMs))) continue;
        const got = await take(fromHex(x.audit), { forwarded: true, relayedAtMs: Number(x.arrivedMs) });
        if (got.ok && got.kept) taken += 1;
      }
    }
    return { asked, taken };
  }
  /** A valid objection against one of the round's results: every AUDIT held for it is contradicted. Answers the node keys newly marked. */
  const contradict = (roundId, why) => {
    const open = rows.all(roundId).filter((r) => r.contradicted === null).map((r) => toHex(new Uint8Array(r.node)));
    if (open.length) mark.run(String(why || 'a valid objection contradicts the results it vouched for'), roundId);
    return open;
  };
  /** The contradicted AUDITs of a round, their bytes and signatures: what the slash proofs against them carry (kanban #724, #725). */
  const contradicted = (roundId) => rows.all(roundId).filter((r) => r.contradicted !== null)
    .map((r) => ({ node: toHex(new Uint8Array(r.node)), bytes: new Uint8Array(r.bytes), signature: new Uint8Array(r.signature) }));
  /** This node's own work as an auditor, for the owner area: the rounds it audited, newest first, and the objections it filed. */
  const ownWork = (nodeBytes, { limit = 200 } = {}) => ({
    rounds: db.prepare('SELECT round_id, at_ms, contradicted FROM audits WHERE node = ? ORDER BY at_ms DESC LIMIT ?').all(nodeBytes, limit)
      .map((r) => ({ round: new Uint8Array(r.round_id), atMs: Number(r.at_ms), contradicted: r.contradicted !== null })),
    audited: Number(db.prepare('SELECT COUNT(*) n FROM audits WHERE node = ?').get(nodeBytes).n),
    objections: Number(db.prepare('SELECT COUNT(*) n FROM audit_objections').get().n),
  });
  const noteObjection = (roundId, entryId, taken) => db.prepare('INSERT OR IGNORE INTO audit_objections (round_id, entry_id, taken, at_ms) VALUES (?, ?, ?, ?)').run(roundId, entryId, taken ? 1 : 0, now());
  return { take, held, list, contradict, contradicted, ownWork, noteObjection, fromRelays };
}
