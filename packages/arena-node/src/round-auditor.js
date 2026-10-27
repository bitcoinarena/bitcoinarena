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

/**
 * WHAT A DRAWN AUDITOR READS AND SENDS, OVER THE ROUND'S SEATS (§13A.1, kanban #725): the network half of RoundAuditor, kept apart so the
 * draw and the rule stay testable with no daemon. The auditor is no seat of the round and holds none of its entries: it asks a seat
 * (GET /audit-run) for every entry and every signed result, counts the agreed run itself against the committee it drew (agreedRunsOf,
 * the same count a seat makes), and replays each entry from what any seat hands out - the canonical transcript, the receipts and the
 * inputs (tools/objection-bundle.mjs, as any objector builds them) - through the very check a seat runs on an objection at its door
 * (`check`, verify.js checkObjection): the replay under the round's own core and beacon, every receipt a committee member's. Agreeing,
 * that check refuses a bundle claiming the signed run ("the replay agrees"); differing, it names the run the replay gives, and the
 * objection then claims that run - the bundle every seat checks again on its own.
 *
 * `seatsFor(rid)` the round's seats (base URLs), `committeeFor(rid)` its signer node keys, `contractOf(rid)` its contract, `check(rid, eid,
 * bundle, signedRunId, { entry, committee })` the seat's objection check, `secret` this node's key (it signs the bundle as the objector),
 * `decodeResult(bytes)` { result, runId } of one signed result.
 */
export function auditorNet({ seatsFor, committeeFor, contractOf, check, secret, buildBundle, decodeEntry, entryIdOf, agreedRunsOf, decodeResult,
  fetcher = fetch, now = () => Date.now(), log = () => {} }) {
  const kept = new Map();   // round hex -> { seat, entries: Map(entry hex -> { entry, runId, signed, replayed }) }
  const fromHexStr = (s) => Uint8Array.from(Buffer.from(String(s), 'hex'));
  const seatList = (rid) => { try { return [...new Set(seatsFor(rid) || [])].map((u) => String(u).replace(/\/+$/, '')); } catch { return []; } };

  async function entriesFor(roundId) {
    const contract = contractOf(roundId), committee = committeeFor(roundId);
    if (!contract || !committee || !committee.length) return null;
    for (const seat of seatList(roundId)) {
      let j;
      try {
        const r = await fetcher(`${seat}/audit-run?round=${toHex(roundId)}`, { signal: AbortSignal.timeout(8000) });
        if (r.status !== 200) continue;
        j = await r.json();
      } catch { continue; }
      const rows = [];
      try {
        for (const x of j.entries || []) {
          const entry = decodeEntry(fromHexStr(x.entry));
          if (toHex(entry.roundId) !== toHex(roundId)) throw new Error('an entry of another round');
          rows.push({ entryId: entryIdOf(entry), entry, results: (x.results || []).map(fromHexStr) });
        }
      } catch (e) { log(`[audit] ${toHex(roundId).slice(0, 16)}: ${seat} hands an entry that does not read: ${e.message}`); continue; }
      const agreed = agreedRunsOf({ contract, committee, entries: rows });
      if (!agreed.ok) return null;          // not all agreed yet at this seat: the next pass asks again
      const entries = new Map();
      for (const [i, run] of agreed.runs.entries()) {
        const signed = rows[i].results.map((b) => { try { return decodeResult(b); } catch { return null; } })
          .find((res) => res && toHex(res.runId) === toHex(run.runId));
        entries.set(toHex(run.entryId), { entry: rows[i].entry, runId: run.runId, signed: signed ? signed.result : null, replayed: null });
      }
      kept.set(toHex(roundId), { seat, entries });
      if (kept.size > 256) kept.delete(kept.keys().next().value);
      return agreed.runs;
    }
    return null;
  }

  const bundleOf = (roundId, entryId, k, claimed) => buildBundle({ base: kept.get(toHex(roundId)).seat, roundId, entryId, signedRunId: k.runId,
    playerPubkey: k.entry.playerPubkey, claimed, objectorSecret: secret, atMs: BigInt(now()), fetcher });

  /** The run this node's replay gives for one entry (bytes), or null when it could not replay it. */
  async function replay(roundId, entryId) {
    const at = kept.get(toHex(roundId)), k = at && at.entries.get(toHex(entryId));
    if (!k || !k.signed) return null;
    const b = await bundleOf(roundId, entryId, k, { outcome: k.signed.outcome, score: k.signed.score });
    const r = await check(roundId, entryId, b.bundle, k.runId, { entry: k.entry, committee: committeeFor(roundId) });
    if (!r || !r.replayedRunId) { log(`[audit] ${toHex(entryId).slice(0, 16)}: not replayed - ${r ? `${r.step}: ${r.why}` : 'no answer'}`); return null; }
    k.replayed = r.replayed;
    return fromHexStr(r.replayedRunId);
  }

  /** The §13A objection for an entry whose replay gave another run: the bundle claiming that run, to every seat. True once one took it. */
  async function object(roundId, entryId) {
    const at = kept.get(toHex(roundId)), k = at && at.entries.get(toHex(entryId));
    if (!k || !k.replayed) return false;
    const b = await bundleOf(roundId, entryId, k, k.replayed);
    let took = false;
    for (const seat of seatList(roundId)) {
      try {
        const r = await fetcher(`${seat}/objection?round=${toHex(roundId)}&entry=${toHex(entryId)}`, { method: 'POST', body: b.bundle, signal: AbortSignal.timeout(60000) });
        if (r.status === 201 || r.status === 200) took = true;
        log(`[audit] ${toHex(entryId).slice(0, 16)}: objection at ${seat}: ${r.status} ${(await r.text()).slice(0, 120)}`);
      } catch (e) { log(`[audit] ${toHex(entryId).slice(0, 16)}: objection at ${seat}: ${e.message}`); }
    }
    return took;
  }

  /** The AUDIT (its bytes and signature) to every seat of the round: the number that took it. */
  async function post(bytes, signature, roundId) {
    const body = new Uint8Array(bytes.length + 64); body.set(bytes); body.set(signature, bytes.length);
    let n = 0;
    for (const seat of seatList(roundId)) {
      try {
        const r = await fetcher(`${seat}/audit`, { method: 'POST', body, signal: AbortSignal.timeout(8000) });
        if (r.status === 201 || r.status === 200) n++;
        else log(`[audit] ${toHex(roundId).slice(0, 16)}: ${seat} refused the AUDIT: ${r.status} ${(await r.text()).slice(0, 160)}`);
      } catch (e) { log(`[audit] ${toHex(roundId).slice(0, 16)}: ${seat}: ${e.message}`); }
    }
    return n;
  }
  return { entriesFor, replay, object, post };
}

