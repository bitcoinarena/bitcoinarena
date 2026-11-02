#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE STALL RULE OVER REAL SEAT DATA (§5A.3 "Stalled in its rounds", kanban #1052: "Replay the rule over the real seat logs of the last 14 days. If it would have benched any honest
// seat, the values change, or it does not ship."). Read-only: every database is opened with mode=ro, nothing is written to a seat and nothing is asked of one. Each seat's notes are
// made as stall-book.js would make them, from what that seat held, and stall.js stalledFrom reads them at every hour of the span.
//
//   RESULT      the seat's no_quorum rows, VOID, with the seats whose results it held when it decided. It wrote no note where it held none of its own.
//   SETTLEMENT  rounds with stakes whose settlement no seat holds as ACCEPTED by final_after + 2 h, with the last refusal the seat logged for the round: the seats that did not sign
//               at the step it stopped at. A log has no times, so "last" is the last line. A seat that logged nothing wrote no note, as one that never asked.
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
import { stalledFrom, namedBy, stallWindow, STALL_STAGE, STALL_SETTLEMENT_WAIT_MS } from '../../arena-protocol/src/stall.js';
import { ABSENCE_PROOF_SPACING_MS, STALL_NOTE_QUORUM, STALL_PROOF_ROUNDS, STALL_WINDOW_MS } from '../../arena-protocol/src/constants.js';

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

const rounds = new Map();          // round hex -> { closeMs, seatRound, series, seats:Set, notes: Map(signer -> { signer, silent:Set, stages:Set }), landedMs, stakes, entries }
const nameOf = new Map();          // node key -> seat name
const endpoints = new Map();       // address -> node key
const census = new Map();          // node key -> weight, newest census read
const coverage = { dbFrom: [], logRounds: new Map() };

function roundOf(hex, contractBytes) {
  if (rounds.has(hex)) return rounds.get(hex);
  let c = null; try { c = decodeRoundContract(new Uint8Array(contractBytes)); } catch { return null; }
  let closeMs; try { closeMs = windowsOf(c).finalAfterMs; } catch { return null; }
  const anchor = tableAnchorOf(c);
  const r = { hex, closeMs, seatRound: anchor ? toHex(anchor.anchorId) : hex, series: c.seriesId instanceof Uint8Array, version: c.protocolVersion, stakeMsat: c.stakeMsat, seats: new Set(), notes: new Map(),
    landedMs: null, entries: 0, game: toHex(c.gameId).slice(0, 8), voided: 0 };
  rounds.set(hex, r);
  return r;
}
const noteOf = (r, signer) => { if (!r.notes.has(signer)) r.notes.set(signer, { signer, silent: new Set(), gone: new Set(), stages: new Set() }); return r.notes.get(signer); };

for (const s of seats) {
  if (!existsSync(s.db)) { say(`${s.name}: no database at ${s.db}`); continue; }
  const db = new DatabaseSync(`file:${s.db}?mode=ro`, { readOnly: true });
  const me = hexOf(db.prepare('SELECT pubkey FROM identity LIMIT 1').get().pubkey);
  s.me = me; nameOf.set(me, s.name);
  const has = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  // rounds with entries: the only ones that can fail
  const rows = db.prepare(`SELECT r.round_id, r.contract, r.opened_ms, COUNT(*) AS n FROM rounds r JOIN entries e ON e.round_id = r.round_id WHERE r.opened_ms > ? GROUP BY r.round_id`).all(fromMs - 86400000);
  for (const row of rows) {
    const hex = hexOf(row.round_id), r = roundOf(hex, row.contract);
    if (!r) continue;
    r.entries = Math.max(r.entries, row.n);
    for (const x of db.prepare('SELECT pubkey FROM signer_nodes WHERE round_id = ?').all(row.round_id)) r.seats.add(hexOf(x.pubkey));
    for (const table of ['lock_settlements', ...(has('fed_lock_settlements') ? ['fed_lock_settlements'] : [])])
      for (const x of db.prepare(`SELECT made_ms FROM ${table} WHERE round_id = ? AND state = 'ACCEPTED'`).all(row.round_id)) if (r.landedMs === null || x.made_ms < r.landedMs) r.landedMs = x.made_ms;
  }
  // RESULT: as stall-book.js resultSilent
  let notes = 0, selfSilent = 0;
  const voids = db.prepare(`SELECT n.round_id, n.entry_id, n.decided_ms, n.why, r.contract FROM no_quorum n JOIN rounds r ON r.round_id = n.round_id WHERE n.outcome = 'VOID' AND n.decided_ms > ?`).all(fromMs);
  for (const v of voids) {
    const hex = hexOf(v.round_id), r = roundOf(hex, v.contract);
    if (!r) continue;
    r.voided++;
    for (const x of db.prepare('SELECT pubkey FROM signer_nodes WHERE round_id = ?').all(v.round_id)) r.seats.add(hexOf(x.pubkey));
    const held = new Set(db.prepare('SELECT node_pubkey FROM results WHERE round_id = ? AND entry_id = ? AND seen_ms <= ?').all(v.round_id, v.entry_id, v.decided_ms).map((x) => hexOf(x.node_pubkey)));
    const list = [...r.seats].filter((k) => !held.has(k));
    if (!r.seats.has(me)) continue;
    if (!held.has(me)) { selfSilent++; continue; }
    if (!list.length) continue;
    const n = noteOf(r, me);
    for (const k of list) { n.silent.add(k); n.gone.add(k); }
    n.stages.add(STALL_STAGE.RESULT);
    notes++;
  }
  // the newest census this seat holds: weights and addresses
  const kept = db.prepare("SELECT body FROM census_kept ORDER BY kept_ms DESC LIMIT 1").get();
  if (kept) {
    const body = JSON.parse(kept.body);
    const key = (x) => (x && x.u8 ? x.u8 : String(x));
    const fresh = new Map();
    for (const e of body.entries || []) {
      const k = key(e.pubkey); fresh.set(k, (fresh.get(k) || 0n) + BigInt((e.bondSats && e.bondSats.big) || 0));
      const ep = e.advert && e.advert.endpoint; if (ep) endpoints.set(addressOf(ep), k);
    }
    for (const [k, w] of fresh) census.set(k, w);
    for (const ex of body.excluded || []) { const ep = ex.advert && ex.advert.endpoint; if (ep) endpoints.set(addressOf(ep), key(ex.pubkey)); }
  }
  coverage.dbFrom.push({ seat: s.name, oldestRoundWithEntries: db.prepare('SELECT MIN(r.opened_ms) AS m FROM rounds r JOIN entries e ON e.round_id = r.round_id').get().m });
  say(`${s.name}: ${rows.length} rounds with entries, ${voids.length} VOID entries, ${notes} listed, ${selfSilent} where it held no result of its own`);
  db.close();
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
const lineStream = (file) => { const raw = createReadStream(file); return createInterface({ input: file.endsWith('.gz') ? raw.pipe(createGunzip()) : raw, crlfDelay: Infinity }); };
const logs = [];
for (const s of seats) {
  const last = new Map();
  let lines = 0;
  for (const file of s.logs) {
    if (!existsSync(file)) continue;
    try {
      for await (const line of lineStream(file)) {
        lines++;
        if (!line.includes(' of the ')) continue;
        const m = REFUSED.exec(line);
        if (!m) continue;
        const prefix = m[1];
        coverage.logRounds.set(prefix, true);
        if (!byPrefix.has(prefix)) continue;
        const refused = [];
        for (const part of m[5].split(/;\s+(?=https?:)/)) {
          const u = /^(https?:\/\/[^\s:]+(?::\d+)?(?:\/[^\s:]*)?):\s*(.*)$/.exec(part.trim());
          if (u) refused.push({ base: u[1].replace(/\/+$/, ''), why: u[2].slice(0, 90) });
        }
        last.set(prefix, { step: m[4] === 'signed the send plan' ? 'plan' : m[4] === 'acked it' ? 'ack' : 'commit', agreed: Number(m[2]), refused });
      }
    } catch (e) { say(`${s.name}: ${file}: ${e.message}`); }
  }
  logs.push({ seat: s.name, lines, rounds: last.size });
  for (const [prefix, l] of last) {
    const r = byPrefix.get(prefix);
    if (!r.seats.has(s.me)) continue;
    const silent = l.refused.map((x) => endpoints.get(x.base)).filter(Boolean).filter((k) => r.seats.has(k) && k !== s.me);
    // a seat that answered with a reason was not gone: it refused by name. The rule cannot tell them apart, the table can
    const gone = l.refused.filter((x) => /fetch failed|timeout|aborted|ECONN|socket|terminated/i.test(x.why)).map((x) => endpoints.get(x.base)).filter(Boolean).filter((k) => r.seats.has(k) && k !== s.me);
    r.unmapped = (r.unmapped || 0) + l.refused.filter((x) => !endpoints.get(x.base)).length;
    (r.whys = r.whys || []).push(...l.refused.map((x) => `${x.why}`));
    if (!silent.length) continue;
    const n = noteOf(r, s.me);
    for (const k of silent) n.silent.add(k);
    for (const k of gone) n.gone.add(k);
    n.stages.add(STALL_STAGE.SETTLEMENT);
  }
  say(`${s.name}: ${lines} log lines, the last refusal of ${last.size} late rounds`);
}

// THE RULE, READ HOURLY. `notes` as stalledFrom takes them, unsigned: nothing here checks a signature
const failed = [...rounds.values()].filter((r) => r.notes.size).map((r) => ({ roundId: r.hex, closeMs: r.closeMs, seatRound: r.seatRound, seated: [...r.seats], series: r.series, stages: new Set([...r.notes.values()].flatMap((n) => [...n.stages])),
  whys: r.whys || [], notes: [...r.notes.values()].map((n) => ({ signer: n.signer, silent: [...n.silent], gone: [...n.gone], bytes: '' })) })).filter((r) => r.closeMs > BigInt(fromMs));
const hour = 3600000n;
const baseWeight = [...census.values()].reduce((a, b) => a + b, 0n);
const allNodes = [...new Set(failed.flatMap((r) => r.notes.flatMap((n) => n.silent)))];
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
  return { node: node.slice(0, 16), who: label(node), listedInRounds: list.length, namedByFourRounds: four.length, resultRounds: four.filter((x) => x.r.stages.has(STALL_STAGE.RESULT)).length, settlementRounds: four.filter((x) => x.r.stages.has(STALL_STAGE.SETTLEMENT)).length,
    days: [...new Set(four.map((x) => utc(x.r.closeMs).slice(5, 10)))].join(' ') };
}).sort((a, b) => b.namedByFourRounds - a.namedByFourRounds || b.listedInRounds - a.listedInRounds);

const table = { nowUtc: utc(nowMs), fromUtc: utc(fromMs), days, seats: seats.map((s) => s.name), coverage: { db: coverage.dbFrom.map((x) => ({ seat: x.seat, from: x.oldestRoundWithEntries ? utc(x.oldestRoundWithEntries) : null })), logs },
  roundsWithEntries: rounds.size, withStakes: [...rounds.values()].filter((r) => r.stakeMsat > 0n).length, roundsVoided: [...rounds.values()].filter((r) => r.voided).length, lateSettlements: late.size,
  failedRoundsWithANote: failed.length, resultFailed: failed.filter((r) => r.stages.has(STALL_STAGE.RESULT)).length, settlementFailed: failed.filter((r) => r.stages.has(STALL_STAGE.SETTLEMENT)).length,
  noteCounts: Object.fromEntries(Object.entries(failed.reduce((a, r) => { a[r.notes.length] = (a[r.notes.length] || 0) + 1; return a; }, {})).sort()),
  failedByDay: Object.fromEntries(Object.entries(failed.reduce((a, r) => { const d = utc(r.closeMs).slice(5, 10); a[d] = (a[d] || 0) + 1; return a; }, {})).sort()),
  cap: { baseWeight: String(baseWeight), censusNodes: census.size }, named,
  out: { ruled: showSpans(replay({ list: failed, baseline: true })), ruledNoCap: showSpans(replay({ list: failed })), seriesRoundsOnly: showSpans(replay({ list: failed.filter((r) => r.series) })),
    onlySeatsThatDidNotAnswer: showSpans(replay({ list: failed.map((r) => ({ ...r, notes: r.notes.map((n) => ({ ...n, silent: n.gone })) })) })),
    resultOnly: showSpans(replay({ list: failed.filter((r) => r.stages.has(STALL_STAGE.RESULT)) })), settlementOnly: showSpans(replay({ list: failed.filter((r) => r.stages.has(STALL_STAGE.SETTLEMENT)) })) },
  sensitivity: Object.fromEntries([['quorum 5', { quorum: 5 }], ['4 rounds', { proofs: 4 }], ['5 rounds', { proofs: 5 }], ['spacing 2 h', { spacing: 2n * hour }], ['spacing 4 h', { spacing: 4n * hour }], ['window 48 h', { window: 48n * hour }], ['quorum 5, 4 rounds, 2 h', { quorum: 5, proofs: 4, spacing: 2n * hour }]]
    .map(([k, o]) => [k, showSpans(replay({ list: failed, ...o }))])),
  whys: Object.entries(failed.flatMap((r) => r.whys).reduce((a, w) => { const k = w.replace(/[0-9a-f]{16,}/g, 'H').slice(0, 60); a[k] = (a[k] || 0) + 1; return a; }, {})).sort((a, b) => b[1] - a[1]).slice(0, 12),
  failed: failed.sort((a, b) => (a.closeMs < b.closeMs ? -1 : 1)).map((r) => ({ round: r.roundId.slice(0, 16), at: utc(r.closeMs), stages: [...r.stages], seats: r.seated.map(label), notes: r.notes.map((n) => ({ by: label(n.signer), silent: n.silent.map(label) })) })) };
const text = JSON.stringify(table, (k, v) => (typeof v === 'bigint' ? String(v) : v), 1);
if (out) writeFileSync(out, text);
const { failed: _f, ...head } = table;
console.log(JSON.stringify(head, (k, v) => (typeof v === 'bigint' ? String(v) : v), 1));
