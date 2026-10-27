// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE NODE AS AN AUDITOR OF ROUNDS IT IS NOT SEATED IN (spec §13A.1, kanban #725, protocol 22). For every paid round of protocol 22 whose
// window is open, a node advertising `audit` runs the round's lottery with its own key (a VRF: nobody else can tell it was drawn); drawn,
// it replays every entry's run and then
//
//   AGREES   every replay gives the run its committee signed: an AUDIT (round, results hash, its key, the time, its VRF proof), signed with
//            its node key and posted to the round's seats - at least AUDIT_LEAD_MS before the window closes, or not at all;
//   OBJECTS  one replay gives another run: the objection of §13A for that entry, to every seat (the seats replay it themselves); no AUDIT.
//
// Not drawn, too late, or a run it cannot replay: nothing is sent. It never signs an AUDIT it has not replayed - an AUDIT over a result a
// valid objection later contradicts slashes its signer (§13A.1).
//
// Everything that touches the network, the census or the replay worker is injected, as drawn-attestor.js does.
import { auditAlpha, isAuditor, auditResultsHash, encodeAudit, auditId, AUDIT_LEAD_MS } from '../../arena-protocol/src/auditor.js';
import { toHex } from '../../arena-protocol/src/hash.js';

export class RoundAuditor {
  /**
   * `selfKey` this node's key (32 bytes); `prove(alpha)` its VRF proof (81 bytes) and `outputOf(pi)` the proof's output (beta);
   * `sign(digest)` its BIP-340 signature; `due()` the rounds whose window is open, [{ roundId (bytes), closeMs }];
   * `eligibleFor(roundId)` { eligible: Map(keyHex -> weight), total } or null; `entriesFor(roundId)` [{ entryId (bytes), runId (bytes) }],
   * the run each entry's committee signed, or null while they are not all signed; `replay(roundId, entryId)` the run id (bytes) this node
   * replays that entry to, or null; `object(roundId, entryId)` posts the objection, true once a seat took it; `post(bytes, signature,
   * roundId)` hands the AUDIT to the round's seats, the number that took it.
   */
  constructor({ selfKey, prove, outputOf, sign, due, eligibleFor, entriesFor, replay, object, post, now = () => Date.now(), log = () => {} }) {
    Object.assign(this, { selfKey, prove, outputOf, sign, due, eligibleFor, entriesFor, replay, object, post, now, log });
    this.draws = new Map();   // round hex -> { drawn, pi }
    this.done = new Map();    // round hex -> 'not drawn' | 'audited' | 'objected' | 'late' | 'could not replay'
  }

  /** Whether this node audits a round, and its proof: drawn once per round, from its own key and the round id only. */
  drawOf(roundId) {
    const id = toHex(roundId);
    if (this.draws.has(id)) return this.draws.get(id);
    const set = this.eligibleFor(roundId);
    const weight = set && set.eligible.get(toHex(this.selfKey));
    let out = { drawn: false, pi: null };
    if (weight) {
      const pi = this.prove(auditAlpha(roundId));
      out = { drawn: isAuditor({ beta: this.outputOf(pi), weight, total: set.total }), pi };
    }
    this.draws.set(id, out);
    return out;
  }

  /** One pass over the rounds due: each audited once, or objected to, or left. */
  async pass() {
    const did = [];
    for (const r of this.due()) {
      const id = toHex(r.roundId);
      if (this.done.has(id)) continue;
      if (this.now() > r.closeMs - AUDIT_LEAD_MS) { this.done.set(id, 'late'); continue; }
      const draw = this.drawOf(r.roundId);
      if (!draw.drawn) { this.done.set(id, 'not drawn'); continue; }
      const entries = await this.entriesFor(r.roundId);
      if (!entries || !entries.length) continue;   // not all signed yet: the next pass
      let differs = null, missing = false;
      for (const e of entries) {
        let got = null;
        try { got = await this.replay(r.roundId, e.entryId); } catch { got = null; }
        if (!got) { missing = true; break; }
        if (toHex(got) !== toHex(e.runId)) { differs = e; break; }
      }
      if (differs) {
        let took = false;
        try { took = await this.object(r.roundId, differs.entryId); } catch { took = false; }
        this.done.set(id, 'objected');
        this.log(`[audit] ${id.slice(0, 16)}: entry ${toHex(differs.entryId).slice(0, 16)} replays to another run - objection ${took ? 'taken' : 'NOT taken'}`);
        did.push({ round: id, objected: toHex(differs.entryId), taken: took });
        continue;
      }
      if (missing) { if (this.now() > r.closeMs - 2 * AUDIT_LEAD_MS) this.done.set(id, 'could not replay'); continue; }
      if (this.now() > r.closeMs - AUDIT_LEAD_MS) { this.done.set(id, 'late'); continue; }
      const audit = { roundId: r.roundId, resultsHash: auditResultsHash(entries.map((e) => ({ entryId: e.entryId, resultDigest: e.runId }))),
        nodePubkey: this.selfKey, atMs: BigInt(this.now()), vrfProof: draw.pi };
      const bytes = encodeAudit(audit), signature = this.sign(auditId(audit));
      let n = 0;
      try { n = await this.post(bytes, signature, r.roundId); } catch { n = 0; }
      this.done.set(id, 'audited');
      this.log(`[audit] ${id.slice(0, 16)}: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} replayed, all as signed - AUDIT taken by ${n} seat(s)`);
      did.push({ round: id, audited: entries.length, seats: n });
    }
    for (const m of [this.draws, this.done]) for (const k of [...m.keys()].slice(0, Math.max(0, m.size - 2048))) m.delete(k);
    return did;
  }
}

