// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SEAT'S STALL BOOK (§5A.3 "Stalled in its rounds", protocol 26, RULED 2026-11-02, kanban #1044 option 2, #1052): the StallNotes of the 72 h before a census, and three jobs.
//
//   signing   after a failed round this seat lists the seats that gave it nothing, once per round and stage, and hands the note to the round's seats and the network's:
//             RESULT      once the round's windows are over (final_after, its re-run window, the re-run's own window), for the entries §13C decided VOID: the seats whose
//                         signed result this seat did not hold at the end of the re-run window. A seat that was not running at that moment signs nothing
//             FINAL       once entries are due (the re-run's own final_after + 60 s, the last moment any entry of the round can be), for the entries with a result at the threshold
//                         and short of their FINAL signatures: the seats that did not sign FINAL for that run. A seat that did not sign it itself lists nobody. Read once
//             SETTLEMENT  2 h after final_after with the settlement not landed: the seats silent at this seat's last settlement pass: no signed word where it stopped (plan, ack, commit
//                         or share), or a refusal after signing FINAL (settlement.js #stoppedAt). By then every seat has had its turn to ask (a turn every 2 blocks, 7 seats). Off below
//                         STALL_SETTLEMENT_HEIGHT (RULED 2026-11-03, #1069): no such note is signed, taken or counted there
//             A seat that was silent itself signs nothing: its own list would have no standing. A seat that never asked has nothing to list. Nothing is noted in a round that worked.
//   posting   the duty node reads the notes it holds and gathers, and carries each stalled node in the census claim with its 3 rounds' notes (stall.js stalledFrom)
//   checking  a seat checks a claim's stalled list on its own draw (stall.js checkStallProof). A signed result held here clears nobody: a claim stands on what it carries (#1052)
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { decodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { provenSeating } from '../../arena-protocol/src/presence.js';
import { windowsOf } from '../../arena-protocol/src/window.js';
import { NO_QUORUM_FINAL_GRACE_MS, stallSettlementPoint } from '../../arena-protocol/src/constants.js';
import { receiptsNeeded } from '../../arena-protocol/src/threshold.js';
import { PROVISIONALLY_FINAL } from '../../arena-protocol/src/objection.js';
import { resultFinality } from './finality.js';
import { STALL_STAGE, STALL_WINDOW_MS, STALL_SETTLEMENT_WAIT_MS, signStallNote, verifyStallNote, stallsOut, settlementNotesCount, stallNoteCounts, stallCloseMs, stallWindow, stalledFrom, stallH3Of, STALL_SEASON_BLOCKS, checkStallProof } from '../../arena-protocol/src/stall.js';

/** Notes are kept this long past their round's close: a census reads 72 h, and a posting is made a day ahead. */
const STALL_KEEP_MS = 7n * 86400000n;
/** At most this many notes or certificates one GET /stall-notes answers. */
export const STALL_NOTES_PER_ANSWER = 4096;
const ACCEPTED_STATE = 'ACCEPTED';
/** Two passes further apart than this mean this seat was not running between them. */
const STALL_TICK_GAP_MS = 300000n;
/** The FINAL stage looks at rounds with a FINAL signature this recent: a round's signatures come inside the 21 minutes up to its moment, and rounds that worked are not walked for 7 days. */
const STALL_FINAL_LOOK_MS = 3600000n;

const weightsOfStall = (entries) => {
  const out = new Map();
  for (const e of entries || []) { const k = toHex(e.pubkey); out.set(k, (out.get(k) || 0n) + BigInt(e.bondSats || 0)); }
  return out;
};
const sumOfStall = (entries) => (entries || []).reduce((s, e) => s + BigInt(e.bondSats || 0), 0n);

export function stallBook({ round, presence, verify, sign, log = () => {}, seatRoundOf = (rid) => rid, hand = async () => {}, stateOf = (rid, entry) => resultFinality(round, rid, entry).state, settlementPointOf = stallSettlementPoint }) {
  const db = round.db;
  db.exec(`
    CREATE TABLE IF NOT EXISTS stall_notes (round_id BLOB NOT NULL, stage INTEGER NOT NULL, signer TEXT NOT NULL, close_ms INTEGER NOT NULL, bytes BLOB NOT NULL,
      PRIMARY KEY (round_id, stage, signer));
    CREATE TABLE IF NOT EXISTS stall_noted (round_id BLOB NOT NULL, stage INTEGER NOT NULL, PRIMARY KEY (round_id, stage));
  `);
  const me = () => toHex(round.pubkey);
  let lastTick = null;
  const contractOfStall = (rid) => { const row = round.get(rid); if (!row) return null; try { return decodeRoundContract(new Uint8Array(row.contract)); } catch { return null; } };

  const keep = (rid, stage, signer, c, bytes) => db.prepare('INSERT OR IGNORE INTO stall_notes (round_id, stage, signer, close_ms, bytes) VALUES (?, ?, ?, ?, ?)').run(rid, stage, signer, Number(stallCloseMs(c)), bytes);
  /** A note handed over: kept when it stands, this seat holds its round, and its round's draw holds its signer. The door is open, and the signer's key is all a stranger needs to bring. */
  function take(bytes) {
    const v = verifyStallNote(bytes, { verify });
    if (!v.ok) return v;
    const rid = fromHex(v.note.roundId), c = contractOfStall(rid);
    if (!c) return { ok: false, why: 'this seat holds no such round' };
    if (!stallsOut(c)) return { ok: false, why: 'that round is not under the stall rule' };
    if (!stallNoteCounts(v.note, c, settlementPointOf)) return { ok: false, why: 'a settlement note does not count at that round: STALL_SETTLEMENT_HEIGHT' };
    const d = presence.drawOf(toHex(seatRoundOf(rid)), 'settlement');
    if (!d) return { ok: false, why: 'this seat cannot draw that round' };
    if (!d.drawn.includes(v.note.signer)) return { ok: false, why: `${v.note.signer.slice(0, 16)} was not drawn for that round` };
    keep(rid, v.note.stage, v.note.signer, c, bytes);
    return { ok: true };
  }

  /**
   * The seats this seat lists for a round's RESULT stage, or null where it signs nothing: its own result missing, or nobody silent. What counts is what it held at the end of the
   * re-run window, the ruling's moment, so a slow seat's result that came after the entry was decided still clears it.
   */
  function resultSilent(rid, seats, untilMs) {
    const voided = db.prepare("SELECT entry_id FROM no_quorum WHERE round_id = ? AND outcome = 'VOID'").all(rid);
    const out = new Set();
    for (const v of voided) {
      const heard = new Set(db.prepare('SELECT node_pubkey FROM results WHERE round_id = ? AND entry_id = ? AND seen_ms <= ?').all(rid, v.entry_id, Number(untilMs)).map((r) => toHex(new Uint8Array(r.node_pubkey))));
      if (!heard.has(me())) continue;                                       // silent itself on this entry: no standing
      for (const k of seats) if (!heard.has(k)) out.add(k);
    }
    return out.size ? [...out] : null;
  }
  /**
   * The seats this seat lists for a round's FINAL stage, or null. An entry counts when it stands at a result's threshold with no decision against it (PROVISIONALLY_FINAL: a VOID is the
   * RESULT stage's, a held objection is no failure) and this seat signed FINAL for the run most seats signed. A round that is FINAL everywhere costs one read of the table.
   */
  function finalSilent(rid, c, seats) {
    const needed = receiptsNeeded(c.settlementSlots), byEntry = new Map();
    for (const r of db.prepare('SELECT entry_id, run_id, signer_pubkey FROM final_sigs WHERE round_id = ?').all(rid)) {
      const e = toHex(new Uint8Array(r.entry_id)), run = toHex(new Uint8Array(r.run_id));
      if (!byEntry.has(e)) byEntry.set(e, new Map());
      const runs = byEntry.get(e);
      if (!runs.has(run)) runs.set(run, new Set());
      runs.get(run).add(toHex(new Uint8Array(r.signer_pubkey)));
    }
    const out = new Set();
    for (const [e, runs] of byEntry) {
      const best = [...runs.values()].sort((a, b) => b.size - a.size)[0];
      if (best.size >= needed || !best.has(me())) continue;
      if (stateOf(rid, fromHex(e)) !== PROVISIONALLY_FINAL) continue;
      for (const k of seats) if (!best.has(k)) out.add(k);
    }
    return out.size ? [...out] : null;
  }
  /** The seats this seat lists for a round's SETTLEMENT stage, or null: landed, or this seat never asked, or nobody silent. */
  function settlementSilent(rid) {
    const landed = (p) => { const kept = p.scope ? round.fedLockSettlement(rid, p.scope) : round.lockSettlement(rid); return !!kept && kept.state === ACCEPTED_STATE; };
    const open = round.settlePassesOf(rid).filter((p) => !landed(p));
    const out = new Set(open.flatMap((p) => p.silent));
    return out.size ? [...out] : null;
  }

  /**
   * One round at this moment: signs what is due, once. Answers the notes signed. `upSinceMs`: since when this seat has been running. MEASURED on seven real seats (kanban #1052): seats
   * stopped through a round came back holding no result of the others, and each listed all of them. So a seat that was not up when the RESULT moment passed signs nothing for it. Its
   * SETTLEMENT list needs no such care: it reads answers to a pass this seat itself ran. The FINAL stage is read once: an entry short at its moment does not fail a second time.
   */
  function noteRound(rid, c, nowMs, { upSinceMs = null } = {}) {
    const seats = round.signerNodes(rid).map((k) => toHex(k));
    if (!seats.includes(me())) return [];
    const win = windowsOf(c), out = [];
    const upAt = (ms) => upSinceMs === null || ms >= BigInt(upSinceMs);
    const entriesDueMs = win.ownFinalAfterMs + NO_QUORUM_FINAL_GRACE_MS;
    const due = [[STALL_STAGE.RESULT, BigInt(nowMs) >= win.ownFinalAfterMs && upAt(win.ownFinalAfterMs), () => resultSilent(rid, seats, win.rerunDeadlineMs)],
      [STALL_STAGE.FINAL, BigInt(nowMs) >= entriesDueMs && upAt(entriesDueMs), () => finalSilent(rid, c, seats), true],
      [STALL_STAGE.SETTLEMENT, settlementNotesCount(c, settlementPointOf) && BigInt(nowMs) >= win.finalAfterMs + STALL_SETTLEMENT_WAIT_MS, () => settlementSilent(rid)]];
    for (const [stage, now, listOf, once = false] of due) {
      if (!now || db.prepare('SELECT 1 FROM stall_noted WHERE round_id = ? AND stage = ?').get(rid, stage)) continue;
      const silent = listOf();
      if (!silent && !once) continue;                                        // asked again next pass: a seat's turn to ask may still come
      db.prepare('INSERT OR IGNORE INTO stall_noted (round_id, stage) VALUES (?, ?)').run(rid, stage);
      if (!silent) continue;
      const bytes = signStallNote({ roundId: rid, stage, silent }, round.pubkey, sign);
      keep(rid, stage, me(), c, bytes);
      out.push(bytes);
      log(`[stall] ${toHex(rid).slice(0, 16)} ${Object.keys(STALL_STAGE).find((k) => STALL_STAGE[k] === stage)}: noted ${silent.length} silent seat(s)`);
    }
    return out;
  }

  /** Every round due, a pass. A round's seats get its notes, then every seat, so the duty node holds them whoever it is. */
  async function tick(nowMs = round.now()) {
    const now = BigInt(nowMs);
    // UP SINCE THE LAST PASS, if that was recent: a pass after a restart, or after this process stood still for 5 minutes, starts the clock again
    const upSinceMs = lastTick !== null && now - lastTick <= STALL_TICK_GAP_MS ? lastTick : now;
    lastTick = now;
    const since = Number(now - STALL_KEEP_MS);
    const made = [];
    const rows = db.prepare(`SELECT DISTINCT round_id FROM no_quorum WHERE outcome = 'VOID' AND decided_ms > ?
      UNION SELECT DISTINCT round_id FROM settle_passes WHERE made_ms > ?
      UNION SELECT DISTINCT round_id FROM final_sigs WHERE seen_ms > ?`).all(since, since, Number(now - STALL_FINAL_LOOK_MS));
    for (const r of rows) {
      const rid = new Uint8Array(r.round_id), c = contractOfStall(rid);
      if (!c || !stallsOut(c)) continue;
      made.push(...noteRound(rid, c, nowMs, { upSinceMs }));
    }
    db.prepare('DELETE FROM stall_notes WHERE close_ms < ?').run(since);
    if (made.length) await hand(made.map((b) => toHex(b)));
    return made;
  }

  const notesIn = (w) => db.prepare('SELECT bytes FROM stall_notes WHERE close_ms > ? AND close_ms <= ? LIMIT ?').all(Number(w.fromMs), Number(w.toMs), STALL_NOTES_PER_ANSWER).map((r) => new Uint8Array(r.bytes));
  /** GET /stall-notes: the notes of the window, and the certificates of the seatings that seat their rounds, as this seat holds them. */
  function answer(w) {
    const notes = notesIn(w);
    const certs = new Set();
    for (const r of db.prepare('SELECT DISTINCT round_id FROM stall_notes WHERE close_ms > ? AND close_ms <= ? LIMIT ?').all(Number(w.fromMs), Number(w.toMs), STALL_NOTES_PER_ANSWER)) {
      const cert = presence.heldCert(seatRoundOf(new Uint8Array(r.round_id)), 'settlement');
      if (cert) certs.add(toHex(cert));
    }
    return { notes: notes.map((b) => toHex(b)), certs: [...certs] };
  }

  /** The failed rounds of the window as this seat reads them: stall.js stalledFrom's `rounds`. A round whose seating cannot be proven here proves nothing here. */
  function roundsIn(w) {
    const byRound = new Map();
    for (const r of db.prepare('SELECT round_id, close_ms, bytes FROM stall_notes WHERE close_ms > ? AND close_ms <= ?').all(Number(w.fromMs), Number(w.toMs))) {
      const h = toHex(new Uint8Array(r.round_id));
      if (!byRound.has(h)) byRound.set(h, { rid: new Uint8Array(r.round_id), closeMs: BigInt(r.close_ms), notes: [], contract: contractOfStall(new Uint8Array(r.round_id)) });
      const x = byRound.get(h), bytes = new Uint8Array(r.bytes), v = verifyStallNote(bytes, { verify });
      if (v.ok && stallNoteCounts(v.note, x.contract, settlementPointOf)) x.notes.push({ ...v.note, bytes: toHex(bytes) });
    }
    const seated = new Map(), out = [];
    for (const [roundId, x] of byRound) {
      const seat = seatRoundOf(x.rid), seatRound = toHex(seat);
      if (!seated.has(seatRound)) {
        let list = null;
        const cert = presence.heldCert(seat, 'settlement'), d = cert ? presence.drawOf(seatRound, 'settlement') : null;
        if (d) { const got = provenSeating(cert, { roundId: seatRound, role: 'settlement', drawn: d.drawn, slots: d.slots, closeMs: d.closeMs, verify }); if (got.ok) list = got.seating.seated; }
        seated.set(seatRound, list);
      }
      if (seated.get(seatRound)) out.push({ roundId, closeMs: x.closeMs, seatRound, seated: seated.get(seatRound), notes: x.notes });
    }
    return out;
  }

  /**
   * THE STALLED, FOR A CENSUS THIS NODE POSTS. `entries` the census past its absent, `t` the census block's median time in ms, `ask(w)` an async answering { notes, certs } (hex)
   * from other seats, each taken first. Answers { stalled, certs }: the claims (stall.js stalledFrom) and, by `${seatRound}:settlement`, the certificates they rest on.
   */
  // THE ROUNDS NAMING A CENSUS ROOT this seat holds (kanban #1350), read once each: root hex -> [{ rid hex, height }]
  const byRoot = new Map();
  let scannedTo = 0;
  function roundsNamingRoot(rootHex) {
    for (const r of db.prepare('SELECT rowid AS n, round_id, contract FROM rounds WHERE rowid > ? ORDER BY rowid').all(scannedTo)) {
      scannedTo = Number(r.n);
      let c; try { c = decodeRoundContract(new Uint8Array(r.contract)); } catch { continue; }
      if (!(c.censusRoot instanceof Uint8Array)) continue;
      const k = toHex(c.censusRoot);
      if (!byRoot.has(k)) byRoot.set(k, []);
      byRoot.get(k).push({ rid: toHex(new Uint8Array(r.round_id)), height: Number(c.censusHeight) });
    }
    return byRoot.get(String(rootHex).toLowerCase()) || [];
  }
  /**
   * THE STALLED TO CARRY FORWARD into a census at `censusHeight` (kanban #1350): from the claims this seat holds, newest first, each node an earlier
   * census below this one listed (with proofs or carried) whose season has not ended - named by that census's root, a duty round of it and H3.
   */
  function carriedFor(censusHeight) {
    const out = new Map();
    const heightOf = (rid) => { try { const c = contractOfStall(fromHex(rid)); return c ? Number(c.censusHeight) : null; } catch { return null; } };
    for (const { root, claim } of presence.claimsHeld ? presence.claimsHeld() : []) {
      if (!Array.isArray(claim.stalled) || !claim.stalled.length) continue;
      const named = roundsNamingRoot(root).filter((x) => x.height < Number(censusHeight)).find((x) => { const d = presence.dutyOf(x.rid); return d && d.ok; });
      if (!named) continue;
      for (const e of claim.stalled) {
        const node = String(e.node).toLowerCase();
        if (out.has(node)) continue;
        const h3 = stallH3Of(e, heightOf);
        if (!Number.isInteger(h3) || !(Number(censusHeight) < h3 + STALL_SEASON_BLOCKS) || named.height < h3) continue;
        out.set(node, { node, carried: { root, roundId: named.rid, h3 } });
      }
    }
    return [...out.values()];
  }

  async function forPosting({ entries, t, ask = null, censusHeight = null }) {
    const w = stallWindow(t);
    if (ask) {
      let got = null;
      try { got = await ask(w); } catch { got = null; }
      for (const b of (got && got.notes) || []) { try { take(fromHex(b)); } catch { /* not one */ } }
      for (const b of (got && got.certs) || []) { try { presence.takeCert(fromHex(b)); } catch { /* not one */ } }
    }
    const weights = weightsOfStall(entries);
    const carried = censusHeight === null ? [] : carriedFor(censusHeight);
    const stalled = stalledFrom({ rounds: roundsIn(w), census: [...weights.keys()], window: w, weightOf: (n) => weights.get(n) || 0n, baseWeight: sumOfStall(entries), dutyOf: presence.dutyOf, carried });
    const certs = {};
    for (const c of stalled) for (const p of c.proofs || []) {
      const key = `${p.seatRound}:settlement`;
      if (!certs[key]) certs[key] = toHex(presence.heldCert(fromHex(p.seatRound), 'settlement'));
    }
    if (stalled.length) log(`[stall] ${stalled.length} node(s) named by 4 seats of 3 failed duty rounds of the 72 h: left out of the census`);
    return { stalled, certs };
  }

  /** A SEAT'S CHECK of a claim's stalled list, past presence.js's check of its absent: every note, on this seat's own draw. Nothing it holds clears a node. */
  function check(claim, { census, w, entries, keptEntries, censusHeight = null }) {
    if (!Array.isArray(claim.stalled) || !claim.stalled.length) return { ok: true };
    const weights = weightsOfStall(entries);
    return checkStallProof(claim.stalled, { census, window: stallWindow(w.toMs), verify, settlementPointOf, censusHeight,
      earlierClaimOf: (root) => (presence.claimFor ? presence.claimFor(root) : null), drawOf: presence.drawOf, dutyOf: presence.dutyOf, weightOf: (n) => weights.get(n) || 0n, keptWeight: sumOfStall(keptEntries),
      roundOf: (ridHex) => { try { return contractOfStall(fromHex(ridHex)); } catch { return null; } },
      certOf: (ridHex, role) => { const h = claim.certs && claim.certs[`${ridHex}:${role}`]; return h ? fromHex(h) : presence.heldCert(fromHex(ridHex), role); } });
  }

  return { take, tick, noteRound, answer, roundsIn, forPosting, check, resultSilent, settlementSilent, notesIn };
}
