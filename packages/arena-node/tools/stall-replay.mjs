#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE STALL RULE OVER REAL SEAT DATA (§5A.3 "Stalled in its rounds", kanban #1052: "Replay the rule over the real seat logs of the last 14 days. If it would have benched any honest
// seat, the values change, or it does not ship."). Read-only: every database is opened with mode=ro, nothing is written to a seat and nothing is asked of one. Each seat's notes are
// made as stall-book.js would make them, from what that seat held, and stall.js stalledFrom reads them at every hour of the span.
//
//   RESULT      the seat's no_quorum rows, VOID, with the seats whose results it held at the end of the re-run window (final_after + 600 s). It wrote no note where it held none
//               of its own. A log has no times, so a seat that was down at that moment is read as if it signed, as stall-book.js would not: the replay names more, not fewer.
//   FINAL       a seat's final_sigs at the moment entries are due (own final_after + 60 s, by each signature's signed time): an entry short of its threshold on the run most seats signed,
//               with no decision against it and no objection, in which this seat signed FINAL itself. The seats that did not sign that run.
//   SETTLEMENT  rounds with stakes whose settlement no seat holds as ACCEPTED by final_after + 2 h, with the last refusal the seat logged for the round, as RULED 2026-11-03 (#1066): the
//               seats that gave no answer at the step it stopped at (plan, ack, commit or share), and the seats that refused by name after signing FINAL, by this seat's final_sigs up to
//               the note's moment. A log has no times, so "last" is the last line and any FINAL held then counts as before the refusal: the replay names more, not fewer. Before the code
//               the share step logged the first refusal only, so a share line names one seat. A seat that logged nothing wrote no note, as one that never asked.
//   TWO READINGS (#1067). `out` is raw, every last line as it stands. `outCleaned` takes out what #1067 measured is no evidence of silence: a line written after its round's 2 h had
//               passed, and the refusals that say nothing of the seat (a series a restart stopped reading, no order filled, fees taking the whole fee, no reserve key known).
//               A log has no times, so a line is dated from below: a settlement refusal is written after its round's final_after, so the log has reached at least the newest such
//               final_after named above it. A line that lies past its own round's moment by that count was written late. It only proves late: an unproven line stays in. A restart
//               re-offers old rounds, so the oldest round a log names does not date the log: `logs.firstInTime` is the oldest round with a line in time.
//
// node tools/stall-replay.mjs --days 14 --out <file.json> --seat <name>=<db>[,<log>...] [--seat ...]
import { DatabaseSync } from 'node:sqlite';
import { createReadStream, writeFileSync, existsSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { decodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { windowsOf } from '../../arena-protocol/src/window.js';
import { tableAnchorOf } from '../../arena-protocol/src/known-game.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { decodeFinalSig, splitSignedFinalSig } from '../../arena-protocol/src/final-sig.js';
import { receiptsNeeded } from '../../arena-protocol/src/threshold.js';
import { stalledFrom, namedBy, stallWindow, STALL_STAGE, STALL_SETTLEMENT_WAIT_MS } from '../../arena-protocol/src/stall.js';
import { ABSENCE_PROOF_SPACING_MS, NO_QUORUM_FINAL_GRACE_MS, STALL_NOTE_QUORUM, STALL_PROOF_ROUNDS, STALL_WINDOW_MS } from '../../arena-protocol/src/constants.js';

const args = process.argv.slice(2);
const seats = [];
let days = 14, out = null, nowMs = Date.now();
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--days') days = Number(args[++i]);
  else if (args[i] === '--out') out = args[++i];
  else if (args[i] === '--now') nowMs = Number(args[++i]);
  else if (args[i] === '--seat') { const [name, list] = args[++i].split('='); const [db, ...logs] = list.split(','); seats.push({ name, db, logs }); }
}
if (!seats.length) { console.error('usage: stall-replay.mjs --days 14 --out file.json --seat name=db[,log...] ...'); process.exit(2); }
const fromMs = nowMs - days * 86400000;
const say = (m) => console.error(`[replay] ${m}`);
const hexOf = (b) => toHex(new Uint8Array(b));
/** An advert's address as a log names it: the doors are http, the adverts may say ws. */
const addressOf = (a) => String(a).replace(/^ws/, 'http').replace(/\/+$/, '');
const utc = (ms) => new Date(Number(ms)).toISOString().slice(0, 16).replace('T', ' ');

const rounds = new Map();          // round hex -> { closeMs, dueMs, seatRound, series, seats:Set, notes: Map(signer -> note), landedMs, stakes, entries }
const nameOf = new Map();          // node key -> seat name
const endpoints = new Map();       // address -> node key
const census = new Map();          // node key -> weight, newest census read
const coverage = { dbFrom: [], logRounds: new Map() };
let censusAt = 0;

function roundOf(hex, contractBytes) {
  if (rounds.has(hex)) return rounds.get(hex);
  let c = null; try { c = decodeRoundContract(new Uint8Array(contractBytes)); } catch { return null; }
  let closeMs, dueMs; try { const w = windowsOf(c); closeMs = w.finalAfterMs; dueMs = w.ownFinalAfterMs + NO_QUORUM_FINAL_GRACE_MS; } catch { return null; }
  const anchor = tableAnchorOf(c);
  const r = { hex, closeMs, dueMs, needed: receiptsNeeded(c.settlementSlots), seatRound: anchor ? toHex(anchor.anchorId) : hex, series: c.seriesId instanceof Uint8Array, version: c.protocolVersion, stakeMsat: c.stakeMsat, seats: new Set(), notes: new Map(),
    landedMs: null, entries: 0, game: toHex(c.gameId).slice(0, 8), voided: 0 };
  rounds.set(hex, r);
  return r;
}
// a note's lists: RESULT, FINAL, and three readings of a settlement: gave no answer, refused after signing FINAL, refused with no FINAL held
const noteOf = (r, signer) => { if (!r.notes.has(signer)) r.notes.set(signer, { signer, result: new Set(), final: new Set(), gone: new Set(), afterFinal: new Set(), refusedOnly: new Set(), cleangone: new Set(), cleanafterFinal: new Set(), cleanrefusedOnly: new Set() }); return r.notes.get(signer); };

// A LIVE DATABASE COPIED OVER MINUTES IS TORN: pages of its fast tables differ. Every read here is by key and survives a page it cannot read; what it missed is counted, and the other seats' rows fill it
const tried = (s, f, fallback) => { try { return f(); } catch { s.torn = (s.torn || 0) + 1; return fallback; } };
// FIRST WHAT EVERY SEAT KNOWS OF A ROUND: its contract and its seats, so a list reads the whole seat set
for (const s of seats) {
  if (!existsSync(s.db)) { say(`${s.name}: no database at ${s.db}`); continue; }
  const db = s.open = new DatabaseSync(`file:${s.db}?mode=ro`, { readOnly: true });
  s.me = hexOf(db.prepare('SELECT pubkey FROM identity LIMIT 1').get().pubkey);
  nameOf.set(s.me, s.name);
  const has = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const contractQ = db.prepare('SELECT contract, opened_ms FROM rounds WHERE round_id = ?'), seatsQ = db.prepare('SELECT pubkey FROM signer_nodes WHERE round_id = ?'), resultQ = db.prepare('SELECT DISTINCT node_pubkey FROM results WHERE round_id = ?');
  const landedQ = ['lock_settlements', ...(has('fed_lock_settlements') ? ['fed_lock_settlements'] : [])].map((t) => db.prepare(`SELECT made_ms FROM ${t} WHERE round_id = ? AND state = 'ACCEPTED'`));
  let n = 0;
  for (const row of tried(s, () => db.prepare('SELECT round_id, COUNT(*) AS n FROM entries GROUP BY round_id').all(), [])) {
    const c = tried(s, () => contractQ.get(row.round_id), null);
    if (c && c.opened_ms <= fromMs - 86400000) continue;
    const hex = hexOf(row.round_id), r = c ? roundOf(hex, c.contract) : rounds.get(hex) || null;
    if (!r) { (s.noContract = s.noContract || []).push(row.round_id); continue; }
    n++;
    r.entries = Math.max(r.entries, row.n);
    for (const x of tried(s, () => seatsQ.all(row.round_id), [])) r.seats.add(hexOf(x.pubkey));
    for (const x of tried(s, () => resultQ.all(row.round_id), [])) r.seats.add(hexOf(x.node_pubkey));
    for (const q of landedQ) for (const x of tried(s, () => q.all(row.round_id), [])) if (r.landedMs === null || x.made_ms < r.landedMs) r.landedMs = x.made_ms;
  }
  coverage.dbFrom.push({ seat: s.name, oldestRoundWithEntries: tried(s, () => db.prepare('SELECT MIN(r.opened_ms) AS m FROM rounds r JOIN entries e ON e.round_id = r.round_id').get().m, null) });
  say(`${s.name}: ${n} rounds with entries read, ${s.torn || 0} reads lost to torn pages`);
}
// THEN EACH SEAT'S RESULT NOTES: as stall-book.js resultSilent
for (const s of seats) {
  const db = s.open;
  if (!db) continue;
  let notes = 0, selfSilent = 0, unknown = 0;
  const voids = tried(s, () => db.prepare("SELECT round_id, entry_id FROM no_quorum WHERE outcome = 'VOID' AND decided_ms > ?").all(fromMs), []);
  for (const v of voids) {
    const hex = hexOf(v.round_id);
    let r = rounds.get(hex);
    if (!r) { const c = tried(s, () => db.prepare('SELECT contract FROM rounds WHERE round_id = ?').get(v.round_id), null); r = c ? roundOf(hex, c.contract) : null; }
    if (!r) { unknown++; continue; }
    r.voided = Math.max(r.voided, 1);
    for (const x of tried(s, () => db.prepare('SELECT pubkey FROM signer_nodes WHERE round_id = ?').all(v.round_id), [])) r.seats.add(hexOf(x.pubkey));
    const held = new Set(tried(s, () => db.prepare('SELECT node_pubkey FROM results WHERE round_id = ? AND entry_id = ? AND seen_ms <= ?').all(v.round_id, v.entry_id, Number(r.closeMs + 600000n)), []).map((x) => hexOf(x.node_pubkey)));
    for (const k of held) r.seats.add(k);
    (r.pending = r.pending || []).push({ s, held });
  }
  // THE FINALS THIS SEAT HOLDS: who signed per round, by the note's moment, and the entries short when they were due
  const decided = new Set(tried(s, () => db.prepare('SELECT entry_id FROM no_quorum').all(), []).map((x) => hexOf(x.entry_id)));
  const objected = new Set(tried(s, () => db.prepare('SELECT entry_id FROM objections').all(), []).map((x) => hexOf(x.entry_id)));
  const byEntry = new Map();
  s.finalsBy = new Map();
  for (const x of tried(s, () => db.prepare('SELECT round_id, entry_id, run_id, signer_pubkey, bytes, seen_ms FROM final_sigs WHERE seen_ms > ?').all(fromMs - 86400000), [])) {
    const hex = hexOf(x.round_id), r = rounds.get(hex);
    if (!r) continue;
    let at = BigInt(x.seen_ms); try { at = decodeFinalSig(splitSignedFinalSig(new Uint8Array(x.bytes)).body).signedAtMs; } catch { /* the time it came */ }
    const who = hexOf(x.signer_pubkey);
    if (at <= r.closeMs + STALL_SETTLEMENT_WAIT_MS) { if (!s.finalsBy.has(hex)) s.finalsBy.set(hex, new Set()); s.finalsBy.get(hex).add(who); }
    if (at > r.dueMs) continue;
    const e = hexOf(x.entry_id), run = hexOf(x.run_id);
    if (!byEntry.has(e)) byEntry.set(e, { r, runs: new Map() });
    const runs = byEntry.get(e).runs;
    if (!runs.has(run)) runs.set(run, new Set());
    runs.get(run).add(who);
  }
  for (const [e, { r, runs }] of byEntry) {
    if (decided.has(e) || objected.has(e)) continue;
    const best = [...runs.values()].sort((a, b) => b.size - a.size)[0];
    if (best.size < r.needed && best.has(s.me)) (r.pendingFinal = r.pendingFinal || []).push({ s, heard: best });
  }
  // the newest census this seat holds: weights and addresses
  const kept = tried(s, () => db.prepare('SELECT body, kept_ms FROM census_kept ORDER BY kept_ms DESC LIMIT 1').get(), null);
  if (kept) {
    const body = JSON.parse(kept.body);
    const key = (x) => (x && x.u8 ? x.u8 : String(x));
    const fresh = new Map();
    for (const e of body.entries || []) {
      const k = key(e.pubkey); fresh.set(k, (fresh.get(k) || 0n) + BigInt((e.bondSats && e.bondSats.big) || 0));
      const ep = e.advert && e.advert.endpoint; if (ep) endpoints.set(addressOf(ep), k);
    }
    if (kept.kept_ms > censusAt) { censusAt = kept.kept_ms; census.clear(); for (const [k, w] of fresh) census.set(k, w); }
    for (const ex of body.excluded || []) { const ep = ex.advert && ex.advert.endpoint; if (ep) endpoints.set(addressOf(ep), key(ex.pubkey)); }
  }
  say(`${s.name}: ${voids.length} VOID entries${unknown ? `, ${unknown} of rounds no seat could read` : ''}`);
  db.close();
}
for (const r of rounds.values()) for (const { s, held } of r.pending || []) {
  if (!r.seats.has(s.me)) continue;
  if (!held.has(s.me)) continue;                    // silent itself on this entry: no standing
  const list = [...r.seats].filter((k) => !held.has(k));
  if (!list.length) continue;
  const n = noteOf(r, s.me);
  for (const k of list) n.result.add(k);
}
for (const r of rounds.values()) for (const { s, heard } of r.pendingFinal || []) {
  if (!r.seats.has(s.me)) continue;
  const list = [...r.seats].filter((k) => !heard.has(k));
  if (!list.length) continue;
  const n = noteOf(r, s.me);
  for (const k of list) n.final.add(k);
}

// SETTLEMENT: rounds with stakes not landed by final_after + 2 h, and the last refusal each seat logged
const late = new Map();
const byPrefix = new Map();
for (const r of rounds.values()) {
  if (!(r.stakeMsat > 0n) || !r.entries || r.closeMs + STALL_SETTLEMENT_WAIT_MS > BigInt(nowMs)) continue;
  if (r.landedMs !== null && BigInt(r.landedMs) <= r.closeMs + STALL_SETTLEMENT_WAIT_MS) continue;
  late.set(r.hex, r); byPrefix.set(r.hex.slice(0, 16), r);
}
say(`${late.size} rounds with stakes did not land within 2 h of final_after`);
const REFUSED = /\b([0-9a-f]{16})\b.*?(\d+) of the (\d+) (?:seats|signer nodes)[^:]*?(signed the send plan|acked it|committed)[^:]*: (.*)$/;
const NO_SHARE = /\b([0-9a-f]{16})\b.*?(https?:\/\/[^\s:]+(?::\d+)?(?:\/[^\s:]*)?) gave no share: (.*)$/;
/** A seat's own federation client timing out: its door threw, so a 5xx, read as no answer. REPLAY_OWN_TIMEOUT_REFUSES reads it as a refusal by name instead. */
const OWN_TIMEOUT = /arena-stake-lock/;
/** No word from the seat: the transport's failure, or a page a tunnel served in its place (settlement.js refusedByName reads the status, which a log lost). */
const NO_ANSWER = /fetch failed|timeout|timed out|aborted|ECONN|socket|terminated|bad gateway|service unavailable|<html|<!doctype|error code/i;
const allByPrefix = new Map([...rounds.values()].map((r) => [r.hex.slice(0, 16), r]));
const lineStream = (file) => { const raw = createReadStream(file); return createInterface({ input: file.endsWith('.gz') ? raw.pipe(createGunzip()) : raw, crlfDelay: Infinity }); };
/** What #1067 measured says nothing of the seat: seats that stopped reading a series at a restart, a round with nothing to claim, a key the network had not yet. */
const NO_EVIDENCE = /names series|no such series|no order filled|guardians' fees on the fee locks|no reserve key is known/;
const logs = [];
for (const s of seats) {
  const last = new Map(), inTime = new Map();
  let lines = 0, oldest = null, firstInTime = null, reached = 0n;
  const saw = (prefix, line) => {
    const r = allByPrefix.get(prefix);
    if (!r) return;
    if (reached <= r.closeMs + STALL_SETTLEMENT_WAIT_MS) { if (byPrefix.has(prefix)) inTime.set(prefix, line); if (firstInTime === null || r.closeMs < firstInTime) firstInTime = r.closeMs; }
    if (r.closeMs > reached) reached = r.closeMs;
  };
  for (const file of s.logs) {
    if (!existsSync(file)) continue;
    try {
      for await (const line of lineStream(file)) {
        lines++;
        if (!line.includes(' of the ') && !line.includes('gave no share')) continue;
        const sh = NO_SHARE.exec(line);
        if (sh) {
          const line2 = { step: 'share', agreed: null, refused: [{ base: sh[2].replace(/\/+$/, ''), why: sh[3].slice(0, 90) }] };
          if (byPrefix.has(sh[1])) last.set(sh[1], line2);
          saw(sh[1], line2);
          continue;
        }
        const m = REFUSED.exec(line);
        if (!m) continue;
        const prefix = m[1];
        { const r = allByPrefix.get(prefix); if (r && (oldest === null || r.closeMs < oldest)) oldest = r.closeMs; }
        const refused = [];
        for (const part of m[5].split(/;\s+(?=https?:)/)) {
          const u = /^(https?:\/\/[^\s:]+(?::\d+)?(?:\/[^\s:]*)?):\s*(.*)$/.exec(part.trim());
          if (u) refused.push({ base: u[1].replace(/\/+$/, ''), why: u[2].slice(0, 90) });
        }
        const parsed = { step: m[4] === 'signed the send plan' ? 'plan' : m[4] === 'acked it' ? 'ack' : 'commit', agreed: Number(m[2]), refused };
        if (byPrefix.has(prefix)) last.set(prefix, parsed);
        saw(prefix, parsed);
      }
    } catch (e) { say(`${s.name}: ${file}: ${e.message}`); }
  }
  logs.push({ seat: s.name, lines, rounds: last.size, roundsInTime: inTime.size, oldestRound: oldest === null ? null : utc(oldest), firstInTime: firstInTime === null ? null : utc(firstInTime) });
  const hold = (l, r, cleaned) => {
    const final = (s.finalsBy && s.finalsBy.get(r.hex)) || new Set();
    const seatOf = (x) => { const k = endpoints.get(x.base); return k && r.seats.has(k) && k !== s.me ? k : null; };
    if (!cleaned) {
      r.unmapped = (r.unmapped || 0) + l.refused.filter((x) => !endpoints.get(x.base)).length;
      (r.whys = r.whys || []).push(...l.refused.map((x) => x.why));
      r.steps = r.steps || {}; r.steps[l.step] = (r.steps[l.step] || 0) + 1;
    }
    for (const x of l.refused) {
      if (cleaned && NO_EVIDENCE.test(x.why)) continue;
      const k = seatOf(x);
      if (!k) continue;
      const n = noteOf(r, s.me);
      const of = (list) => (cleaned ? `clean${list}` : list);
      const gone = NO_ANSWER.test(x.why) && !(process.env.REPLAY_OWN_TIMEOUT_REFUSES && OWN_TIMEOUT.test(x.why));
      if (!cleaned) (r.refusals = r.refusals || []).push({ by: k, step: l.step, why: x.why, final: final.has(k) });
      else (r.cleanRefusals = r.cleanRefusals || []).push({ by: k, step: l.step, why: x.why, final: final.has(k) });
      if (gone) n[of('gone')].add(k);
      else if (final.has(k)) { n[of('afterFinal')].add(k); if (!cleaned) (r.afterFinalWhys = r.afterFinalWhys || []).push(`${l.step}: ${x.why}`); }
      else n[of('refusedOnly')].add(k);
    }
  };
  for (const [prefix, l] of last) { const r = byPrefix.get(prefix); if (r.seats.has(s.me)) hold(l, r, false); }
  for (const [prefix, l] of inTime) { const r = byPrefix.get(prefix); if (r.seats.has(s.me)) hold(l, r, true); }
  say(`${s.name}: ${lines} log lines, the last refusal of ${last.size} late rounds`);
}

// THE RULE, READ HOURLY. Each reading is the failed rounds with each note's list as that reading makes it, as stalledFrom takes them, unsigned: nothing here checks a signature
const failedAll = [...rounds.values()].filter((r) => r.notes.size && r.closeMs > BigInt(fromMs));
const SETTLE = { ruled: ['gone', 'afterFinal'], noAnswer: ['gone'], everyRefusal: ['gone', 'afterFinal', 'refusedOnly'], none: [], cleanruled: ['cleangone', 'cleanafterFinal'], cleannoAnswer: ['cleangone'], cleaneveryRefusal: ['cleangone', 'cleanafterFinal', 'cleanrefusedOnly'], cleannone: [] };
const STAGE_OF = { result: STALL_STAGE.RESULT, final: STALL_STAGE.FINAL, gone: STALL_STAGE.SETTLEMENT, afterFinal: STALL_STAGE.SETTLEMENT, refusedOnly: STALL_STAGE.SETTLEMENT, cleangone: STALL_STAGE.SETTLEMENT, cleanafterFinal: STALL_STAGE.SETTLEMENT, cleanrefusedOnly: STALL_STAGE.SETTLEMENT };
function reading({ result = true, final = true, settlement = 'ruled', cleaned = false }) {
  const lists = [...(result ? ['result'] : []), ...(final ? ['final'] : []), ...SETTLE[cleaned ? `clean${settlement}` : settlement]];
  return failedAll.map((r) => {
    const notes = [...r.notes.values()].map((n) => ({ signer: n.signer, silent: [...new Set(lists.flatMap((l) => [...n[l]]))], lists: lists.filter((l) => n[l].size), bytes: '' })).filter((n) => n.silent.length);
    return { refusals: (cleaned ? r.cleanRefusals : r.refusals) || [], roundId: r.hex, closeMs: r.closeMs, seatRound: r.seatRound, seated: [...r.seats], series: r.series, notes, whys: r.whys || [], afterFinalWhys: r.afterFinalWhys || [], steps: r.steps || {}, stages: new Set(notes.flatMap((n) => n.lists.map((l) => STAGE_OF[l]))) };
  }).filter((r) => r.notes.length);
}
const failed = reading({});
const hour = 3600000n;
const baseWeight = [...census.values()].reduce((a, b) => a + b, 0n);
const allNodes = [...new Set(reading({ settlement: 'everyRefusal' }).flatMap((r) => r.notes.flatMap((n) => n.silent)))];
const weightOf = (n) => census.get(n) || 0n;

/** Who is out at each hour, under one set of values. `list` the rounds that count. `cap` false reads the rule without its cap. */
function replay({ list, quorum = STALL_NOTE_QUORUM, proofs = STALL_PROOF_ROUNDS, spacing = ABSENCE_PROOF_SPACING_MS, window = STALL_WINDOW_MS, baseline = false }) {
  const spans = new Map();
  for (let T = BigInt(fromMs); T <= BigInt(nowMs); T += hour) {
    let outNow;
    if (baseline) outNow = stalledFrom({ rounds: list, census: allNodes, window: stallWindow(T), weightOf, baseWeight }).map((c) => c.node);
    else {
      outNow = [];
      for (const node of allNodes) {
        let last = null, n = 0; const draws = new Set();
        for (const r of [...list].sort((a, b) => (a.closeMs < b.closeMs ? -1 : 1))) {
          if (!(r.closeMs > T - window && r.closeMs <= T) || draws.has(r.seatRound) || (last !== null && r.closeMs - last < spacing)) continue;
          const by = new Set(namedBy(node, r.notes, r.seated).map((x) => x.signer));
          if (by.size < quorum) continue;
          last = r.closeMs; draws.add(r.seatRound); n++;
        }
        if (n >= proofs) outNow.push(node);
      }
    }
    for (const node of outNow) {
      const s = spans.get(node) || spans.set(node, []).get(node);
      const at = s[s.length - 1];
      if (at && T - at.to <= hour) at.to = T; else s.push({ from: T, to: T });
    }
  }
  return spans;
}
const label = (k) => nameOf.get(k) || `outside ${k.slice(0, 8)}`;
const showSpans = (spans) => [...spans.entries()].map(([k, s]) => ({ node: k.slice(0, 16), who: label(k), hours: s.reduce((a, x) => a + Number((x.to - x.from) / hour) + 1, 0), spans: s.map((x) => `${utc(x.from)}..${utc(x.to)}`) }));

const named = allNodes.map((node) => {
  const list = failed.map((r) => ({ r, by: namedBy(node, r.notes, r.seated) })).filter((x) => x.by.length);
  const four = list.filter((x) => x.by.length >= STALL_NOTE_QUORUM);
  return { node: node.slice(0, 16), who: label(node), listedInRounds: list.length, namedByFourRounds: four.length, resultRounds: four.filter((x) => x.r.stages.has(STALL_STAGE.RESULT)).length, finalRounds: four.filter((x) => x.r.stages.has(STALL_STAGE.FINAL)).length, settlementRounds: four.filter((x) => x.r.stages.has(STALL_STAGE.SETTLEMENT)).length,
    days: [...new Set(four.map((x) => utc(x.r.closeMs).slice(5, 10)))].join(' ') };
}).sort((a, b) => b.namedByFourRounds - a.namedByFourRounds || b.listedInRounds - a.listedInRounds);

const outOf = (cleaned) => {
  const list = reading({ cleaned }), before = reading({ final: false, settlement: 'everyRefusal', cleaned });
  return { ruled: showSpans(replay({ list, baseline: true })), ruledNoCap: showSpans(replay({ list })),
    resultOnly: showSpans(replay({ list: reading({ final: false, settlement: 'none', cleaned }) })), finalOnly: showSpans(replay({ list: reading({ result: false, settlement: 'none', cleaned }) })),
    settlementOnly: showSpans(replay({ list: reading({ result: false, final: false, cleaned }) })), resultAndFinal: showSpans(replay({ list: reading({ settlement: 'none', cleaned }) })),
    settlementNoAnswerOnly: showSpans(replay({ list: reading({ result: false, final: false, settlement: 'noAnswer', cleaned }) })),
    beforeRuling: showSpans(replay({ list: before, baseline: true })), beforeRulingNoCap: showSpans(replay({ list: before })) };
};
const namedIn = (list) => allNodes.map((node) => { const four = list.filter((r) => namedBy(node, r.notes, r.seated).length >= STALL_NOTE_QUORUM); return { who: label(node), rounds: four.length, draws: new Set(four.map((r) => r.seatRound)).size, list: four.map((r) => `${r.roundId.slice(0, 8)} ${utc(r.closeMs).slice(5)}`) }; }).filter((x) => x.rounds).sort((a, b) => b.rounds - a.rounds);
const bySeat = (list) => Object.fromEntries(allNodes.map((node) => [label(node), Object.entries(list.flatMap((r) => r.refusals).filter((x) => x.by === node).reduce((a, x) => { const k = `${x.step} ${x.final ? 'after FINAL' : 'no FINAL'}: ${x.why.replace(/[0-9a-f]{16,}/g, 'H').slice(0, 52)}`; a[k] = (a[k] || 0) + 1; return a; }, {})).sort((a, b) => b[1] - a[1]).slice(0, 8)]).filter(([, v]) => v.length));
const table = { nowUtc: utc(nowMs), fromUtc: utc(fromMs), days, seats: seats.map((s) => s.name), coverage: { db: coverage.dbFrom.map((x) => ({ seat: x.seat, from: x.oldestRoundWithEntries ? utc(x.oldestRoundWithEntries) : null })), torn: seats.map((s) => [s.name, s.torn || 0, (s.noContract || []).length]), logs },
  roundsWithEntries: rounds.size, withStakes: [...rounds.values()].filter((r) => r.stakeMsat > 0n).length, roundsVoided: [...rounds.values()].filter((r) => r.voided).length, lateSettlements: late.size,
  failedRoundsWithANote: failed.length, resultFailed: failed.filter((r) => r.stages.has(STALL_STAGE.RESULT)).length, finalFailed: failed.filter((r) => r.stages.has(STALL_STAGE.FINAL)).length, settlementFailed: failed.filter((r) => r.stages.has(STALL_STAGE.SETTLEMENT)).length,
  roundsOfAnyNote: failedAll.length, stepsWhereSeatsStopped: failed.reduce((a, r) => { for (const [k, v] of Object.entries(r.steps)) a[k] = (a[k] || 0) + v; return a; }, {}),
  noteCounts: Object.fromEntries(Object.entries(failed.reduce((a, r) => { a[r.notes.length] = (a[r.notes.length] || 0) + 1; return a; }, {})).sort()),
  failedByDay: Object.fromEntries(Object.entries(failed.reduce((a, r) => { const d = utc(r.closeMs).slice(5, 10); a[d] = (a[d] || 0) + 1; return a; }, {})).sort()),
  cap: { baseWeight: String(baseWeight), censusNodes: census.size }, named,
  out: outOf(false), outCleaned: outOf(true), failedCleaned: reading({ cleaned: true }).length, settlementFailedCleaned: reading({ cleaned: true }).filter((r) => r.stages.has(STALL_STAGE.SETTLEMENT)).length,
  sensitivity: Object.fromEntries([['4 rounds', { proofs: 4 }], ['5 rounds', { proofs: 5 }], ['spacing 2 h', { spacing: 2n * hour }], ['4 rounds, 2 h', { proofs: 4, spacing: 2n * hour }], ['spacing 4 h', { spacing: 4n * hour }], ['window 48 h', { window: 48n * hour }]]
    .map(([k, o]) => [k, showSpans(replay({ list: failed, ...o }))])),
  namedRaw: namedIn(reading({})), namedCleaned: namedIn(reading({ cleaned: true })), refusalsBySeat: bySeat(reading({})), refusalsBySeatCleaned: bySeat(reading({ cleaned: true })),
  afterFinalWhys: Object.entries(failed.flatMap((r) => r.afterFinalWhys).reduce((a, w) => { const k = w.replace(/[0-9a-f]{16,}/g, 'H').slice(0, 70); a[k] = (a[k] || 0) + 1; return a; }, {})).sort((a, b) => b[1] - a[1]).slice(0, 20),
  whysByDay: Object.fromEntries(Object.entries(failed.reduce((a, r) => { const d = utc(r.closeMs).slice(5, 10); for (const w of r.whys) { const k = /names series/.test(w) ? 'no such series' : /no lock is claimed/.test(w) ? 'nothing to claim' : /fetch failed|timed out|timeout/.test(w) ? 'no answer' : /reading the other seats/.test(w) ? 'still reading batches' : /rebuilt settlement/.test(w) ? 'another settlement' : 'other'; a[d] = a[d] || {}; a[d][k] = (a[d][k] || 0) + 1; } return a; }, {})).sort()),
  whys: Object.entries(failed.flatMap((r) => r.whys).reduce((a, w) => { const k = w.replace(/[0-9a-f]{16,}/g, 'H').slice(0, 60); a[k] = (a[k] || 0) + 1; return a; }, {})).sort((a, b) => b[1] - a[1]).slice(0, 12),
  failed: failed.sort((a, b) => (a.closeMs < b.closeMs ? -1 : 1)).map((r) => ({ round: r.roundId.slice(0, 16), at: utc(r.closeMs), stages: [...r.stages], seats: r.seated.map(label), notes: r.notes.map((n) => ({ by: label(n.signer), lists: n.lists, silent: n.silent.map(label) })), afterFinalWhys: r.afterFinalWhys })) };
const text = JSON.stringify(table, (k, v) => (typeof v === 'bigint' ? String(v) : v), 1);
if (out) writeFileSync(out, text);
const { failed: _f, ...head } = table;
console.log(JSON.stringify(head, (k, v) => (typeof v === 'bigint' ? String(v) : v), 1));
