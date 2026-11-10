// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE NODE AS AN AUDITOR OF HEAD-TO-HEAD ROUNDS (spec §13A.1, RULED 2026-11-10 kanban #1400, build #1412). For every head-to-head round on the short
// window that this node holds and is not seated in, from its PROVISIONALLY_FINAL until the 60 s window closes, a node advertising `audit` runs the
// round's lottery with its own key (five expected); drawn, it reads the round from a seat - the entries (their commitments), the reveals with when the
// seat took them, and the committee's signed results - and
//
//   AGREES   its own check (h2h-audit.js h2hCheck: every commitment against its reveal, FORFEIT for none, VOID under the players, the game's decide over
//            the stood reveals) gives the results hash the committee agreed: an H2H_AUDIT, signed with its node key, posted to every seat of the round
//            (POST /h2h-audit) while the window is open;
//   DIFFERS  no H2H_AUDIT (the ordinary §13A objection is the dissent's path; logged here).
//
// Nothing waits in the round's own clock for it: commit, reveal and decide are unchanged (the owner: "the audit runs in the background").
import { auditAlpha } from '../../arena-protocol/src/auditor.js';
import { isH2hAuditor, h2hCheck, encodeH2hAudit, h2hAuditId } from '../../arena-protocol/src/h2h-audit.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { h2hAgreedResultsOf } from './h2h-audit-desk.js';

export class H2hAuditor {
  /**
   * `selfKey` this node's key; `prove(alpha)` its VRF proof and `outputOf(pi)` the proof's output; `sign(digest)` its BIP-340 signature; `due()` the
   * head-to-head rounds whose short window is open, [{ roundId, closeMs }]; `eligibleFor(roundId)` { eligible, total } or null; `dataFor(roundId)` the
   * check's inputs and the committee's agreed hash ({ check: h2hCheck's arguments, agreedHash } or null while not every entry is agreed);
   * `post(bytes, signature, roundId)` the number of seats that took it.
   */
  constructor({ selfKey, prove, outputOf, sign, due, eligibleFor, dataFor, post, now = () => Date.now(), log = () => {} }) {
    Object.assign(this, { selfKey, prove, outputOf, sign, due, eligibleFor, dataFor, post, now, log });
    this.draws = new Map();
    this.done = new Map();   // round hex -> 'not drawn' | 'audited' | 'differs' | 'late'
  }

  drawOf(roundId) {
    const id = toHex(roundId);
    if (this.draws.has(id)) return this.draws.get(id);
    const set = this.eligibleFor(roundId);
    const weight = set && set.eligible.get(toHex(this.selfKey));
    let out = { drawn: false, pi: null, beta: null };
    if (weight) { const pi = this.prove(auditAlpha(roundId)), beta = this.outputOf(pi); out = { drawn: isH2hAuditor({ beta, weight, total: set.total }), pi, beta }; }
    this.draws.set(id, out);
    return out;
  }

  /** One pass over the rounds due: each audited once, found to differ, or left for the next pass while its results are not all agreed. */
  async pass() {
    const did = [];
    for (const r of this.due()) {
      const id = toHex(r.roundId);
      if (this.done.has(id)) continue;
      if (this.now() > r.closeMs) { this.done.set(id, 'late'); continue; }
      const draw = this.drawOf(r.roundId);
      if (!draw.drawn) { this.done.set(id, 'not drawn'); continue; }
      let data = null; try { data = await this.dataFor(r.roundId); } catch { data = null; }
      if (!data) continue;   // not every entry agreed yet: the next pass
      let mine;
      try { mine = h2hCheck(data.check); } catch (e) { this.log(`[h2h-audit] ${id.slice(0, 16)}: the check failed: ${e.message}`); continue; }
      if (toHex(mine.resultsHash) !== toHex(data.agreedHash)) {
        this.done.set(id, 'differs');
        this.log(`[h2h-audit] ${id.slice(0, 16)}: the committee's results are not what the moves give${mine.refused.length ? ` (${mine.refused.map((x) => x.why).join('; ')})` : ''} - no H2H_AUDIT; the dissent is a §13A objection`);
        did.push({ round: id, differs: true });
        continue;
      }
      if (this.now() > r.closeMs) { this.done.set(id, 'late'); continue; }
      const audit = { roundId: r.roundId, resultsHash: mine.resultsHash, nodePubkey: this.selfKey, atMs: BigInt(this.now()), beta: draw.beta, vrfProof: draw.pi };
      const bytes = encodeH2hAudit(audit), signature = this.sign(h2hAuditId(audit));
      let n = 0; try { n = await this.post(bytes, signature, r.roundId); } catch { n = 0; }
      this.done.set(id, 'audited');
      this.log(`[h2h-audit] ${id.slice(0, 16)}: ${data.check.entries.length} entries checked, as agreed - H2H_AUDIT taken by ${n} seat(s)`);
      did.push({ round: id, audited: data.check.entries.length, seats: n });
    }
    for (const m of [this.draws, this.done]) for (const k of [...m.keys()].slice(0, Math.max(0, m.size - 2048))) m.delete(k);
    return did;
  }
}

/**
 * WHAT A DRAWN HEAD-TO-HEAD AUDITOR READS AND SENDS, over the round's seats: GET /audit-run (every entry's contract and signed results) and GET
 * /reveals (the moves, salts and when the seat took each) at the first seat that answers both; the committee's agreed results counted here as a seat
 * counts them (h2hAgreedResultsOf); POST /h2h-audit to every seat. `decideFor(roundId)` the game's decide adapter as this node hosts it, with
 * { moveCount, players, config }; `committeeFor`, `contractOf`, `decodeEntry` as the server has them.
 */
export function h2hAuditorNet({ seatsFor, committeeFor, contractOf, decodeEntry, decideFor, revealWindowOf, fetcher = (u, o) => fetch(u, o), timeoutMs = 6000 }) {
  async function dataFor(roundId) {
    const c = contractOf(roundId), committee = committeeFor(roundId), game = decideFor(roundId);
    if (!c || !committee || !game) return null;
    for (const seat of seatsFor(roundId)) {
      const base = String(seat).replace(/\/+$/, '');
      try {
        const [run, rev] = await Promise.all([`${base}/audit-run?round=${toHex(roundId)}`, `${base}/reveals?round=${toHex(roundId)}`]
          .map((u) => fetcher(u, { signal: AbortSignal.timeout(timeoutMs) }).then((r) => (r.ok ? r.json() : null))));
        if (!run || !rev || !Array.isArray(run.entries) || !Array.isArray(rev.reveals)) continue;
        const entries = run.entries.map((x) => ({ entryId: fromHex(x.id), entry: decodeEntry(fromHex(x.entry)), results: (x.results || []).map(fromHex) }));
        const agreed = h2hAgreedResultsOf({ contract: c, committee, entries });
        if (!agreed.ok) return null;
        const revealOf = new Map(rev.reveals.map((x) => [x.entry, x]));
        const check = { roundId, decide: game.decide, config: game.config, moveCount: game.moveCount, players: game.players,
          entryCloseMs: c.entryCloseMs, revealWindowMs: revealWindowOf(c),
          entries: entries.map((e) => { const x = revealOf.get(toHex(e.entryId));
            // a reveal the seat took names when (receivedMs); one with no time is judged at the window's start, as it stood at that seat
            return { entryId: e.entryId, entryKey: e.entry.sessionPubkey, commit: e.entry.commit,
              reveal: x ? { move: Number(x.move), salt: fromHex(x.salt), atMs: Number.isFinite(Number(x.receivedMs)) ? BigInt(x.receivedMs) : c.entryCloseMs } : null }; }) };
        return { check, agreedHash: agreed.resultsHash };
      } catch { /* the next seat */ }
    }
    return null;
  }
  async function post(bytes, signature, roundId) {
    const body = new Uint8Array(bytes.length + 64); body.set(bytes); body.set(signature, bytes.length);
    const took = await Promise.all(seatsFor(roundId).map((seat) => fetcher(`${String(seat).replace(/\/+$/, '')}/h2h-audit`, { method: 'POST', body, signal: AbortSignal.timeout(timeoutMs) })
      .then((r) => r.status === 201 || r.status === 200, () => false)));
    return took.filter(Boolean).length;
  }
  return { dataFor, post };
}
