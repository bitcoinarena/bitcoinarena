// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SEAT AS ONE OF ITS ROUND'S DRAWN ATTESTORS (kanban #630, protocol 21; 2026-10-24: "Atteststiom should also be pre deterministic
// and be drawed randomly, not a fixed set of nodes ... 5 of 7 is needed"). A game whose manifest names a draw (manifest.js attestDraw) has
// no attestor daemons: each round's 7 attestors are node keys of its census (sortition.js drawAttestors), and a seat drawn for a round
// does what arena-attestor's daemon does for a fixed key:
//
//   READ.    Its own price, every READ_MS (the seat's feed read, cents), kept for KEEP_MS (the longest market window + its due time,
//            kanban #2406) and while a round that needs it is due (kanban #2186).
//   SIGN.    Once the round's window has ended (+ SETTLE_MS), the market's rule over its own readings (up-down.js upDownOutcome) and
//            the attestation body {round, outcome, observed_at = the window's end}, signed BIP-340 with its node key. One word a
//            round: kept, never signed again differently.
//   SERVE.   GET /attestation-word?round= answers that word (wordToJson), so the other drawn seats can combine it.
//   COMBINE. It asks the round's other drawn attestors for theirs; once 5 of the 7 signed one body, that attestation is held here
//            (the /outcome intake, which checks it against the draw) and handed to every seat of the round.
//
// Honest seats whose readings agree sign the same bytes. Seats that read a near tie differently sign different bodies; only 5 over
// ONE body make an attestation, and a round with none by its deadline is refunded as any unattested market is.
import { attestationBodyId } from '../../arena-protocol/src/attested.js';
import { upDownOutcome, UP_DOWN_AVERAGE_MS } from '../../arena-protocol/src/up-down.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { combine, wordToJson, wordFromJson } from '../../arena-attestor/src/attestor.js';
import { jsonUpTo } from './body-read.js';
// the most of one drawn seat's GET /attestation-word answer that is read (kanban #2458)
const WORD_ANSWER_MAX = 16 * 1024;

export const READ_MS = 10000;
// HOW LONG A ROUND IS DUE AFTER ITS WINDOW ENDED (server.js due() lists a drawn round until then; kanban #2186): one constant, so the
// readings are never dropped while a round can still be signed
export const DUE_AFTER_END_MS = 30 * 60 * 1000;
// KEPT AT LEAST 2 H, as the fixed daemon (arena-attestor.mjs KEEP_MS), AND NEVER BELOW THE READING IN FORCE A MINUTE BEFORE THE START OF
// A ROUND STILL DUE (kanban #2186, #1489 refute of #1844): 40 min dropped the reading before a 15 min window's start 24 min after its end,
// while server.js keeps the round due 30 min - a seat back 25 min after the end read the whole window and could not sign it.
// AND NEVER BELOW THE LONGEST LEGAL MARKET WINDOW, DUE, AND THE MINUTE BEFORE IT (kanban #2406, #1489 a44 refute 91-s2): a drawn
// market may run on any period a day divides (manifest.js seriesPeriodFits), and a round is due only once its window ENDED - so with
// 2 h a 3 h window's reading in force a minute before its start was pruned 2 h in, while the round was not yet due; no seat could read
// the price to beat and every round of the market went VOID. A day (the longest period a day divides) + DUE_AFTER_END_MS + 60 s:
// one reading every READ_MS, about 8,900 rows at most.
export const MAX_MARKET_PERIOD_MS = 24 * 3600 * 1000;
export const KEEP_MS = Math.max(2 * 3600 * 1000, MAX_MARKET_PERIOD_MS + DUE_AFTER_END_MS + Number(UP_DOWN_AVERAGE_MS));
export const SETTLE_MS = 5000;
export const ASK_MS = 4000;
// kanban #2461: the longest stretch between two of this seat's readings it still counts as having read (two missed reads)
export const READ_GAP_MS = 3 * READ_MS;

/**
 * WAS THE WINDOW READ (kanban #2461, state audit 2026-11-12): upDownPrices takes each reading as in force until the next, so a seat
 * that was down over the window's end and came back with the readings from before its downtime (#1844 restores them) would sign the
 * END PRICE from a reading minutes old. Each of the two 60 s averages counts only when this seat read it: a reading at most
 * READ_GAP_MS before the average's first moment, no gap over READ_GAP_MS between readings inside it, and one at most READ_GAP_MS
 * before its last moment. A window not read is signed by nobody here - as before #1844 for a seat without the readings.
 */
export function windowRead(samples, { startMs, endMs }, gapMs = BigInt(READ_GAP_MS)) {
  const at = samples.map((x) => x.atMs).filter((t) => typeof t === 'bigint').sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const to of [startMs, endMs]) {
    const from = to - UP_DOWN_AVERAGE_MS;
    const inForce = at.filter((t) => t <= from);
    let last = inForce.length ? inForce[inForce.length - 1] : null;
    if (last === null || from - last > gapMs) return false;
    for (const t of at.filter((y) => y > from && y < to)) { if (t - last > gapMs) return false; last = t; }
    if (to - last > gapMs) return false;
  }
  return true;
}

export class DrawnAttestor {
  /**
   * `readPrice()` cents or null; `selfKey` this seat's node key (hex); `sign(digest)` its BIP-340 signature (bytes);
   * `attestorsFor(roundIdBytes)` the round's 7 drawn keys (hex) or null; `peersFor(roundIdBytes)` the drawn attestors' base URLs
   * (this seat's left out); `due()` the rounds to attest now, [{ roundId (bytes), window { startMs, endMs } }]; `hold(bytes, roundId)`
   * takes a combined attestation (this seat's intake, then every seat): true held here and taken by every seat, false not held,
   * { held: true, delivered: false } held here but some seat has not taken it yet (asked again each pass while due); `threshold` 5;
   * `db` the seat's store (node:sqlite), where the readings and the signed words are kept across a restart (kanban #1844).
   */
  constructor({ readPrice, selfKey, sign, verify, attestorsFor, peersFor, due, hold, threshold = 5, fetcher = (u, o) => fetch(u, o), now = () => Date.now(), db = null }) {
    if (typeof verify !== 'function') throw new Error('a drawn attestor needs verify(signature, bodyId, key): the drawn keys\' BIP-340 check (kanban #1487)');
    Object.assign(this, { readPrice, selfKey, sign, verify, attestorsFor, peersFor, due, hold, threshold, fetcher, now, db });
    this.samples = [];          // [{ atMs, price }] BigInt, this seat's own readings
    this.words = new Map();     // round hex -> this seat's word
    this.held = new Set();      // round hex: an attestation of it is held - nothing more to do
    this.delivering = new Map(); // round hex -> combined bytes: held here, not yet taken by every seat of the round (kanban #1989)
    // THE READINGS AND WORDS IN THE SEAT'S STORE (kanban #1844, state audit 2026-11-12): kept in memory only, a seat restarted after
    // its round's window ended (a host reboot, a roll of the seats) came back with no reading before the window's start and never
    // signed it - three of seven drawn seats restarted together and the market went VOID although all seven read the window. As the
    // fixed daemon keeps them on disk (arena-attestor.mjs SAMPLES_FILE), each reading is written as it is taken and the last KEEP_MS
    // read back here; a signed word is written before it is served (INSERT OR IGNORE: the first body stays), so a restart never signs
    // a second body for a round.
    if (db) {
      db.exec('CREATE TABLE IF NOT EXISTS drawn_samples (at_ms INTEGER PRIMARY KEY, price TEXT NOT NULL)');
      db.exec('CREATE TABLE IF NOT EXISTS drawn_words (round_hex TEXT PRIMARY KEY, word TEXT NOT NULL)');
      // every row kept (kanban #2186): the table is pruned by read() to what a due round still needs, which only a pass knows
      for (const r of db.prepare('SELECT at_ms AS at, price FROM drawn_samples ORDER BY at_ms').all()) {
        this.samples.push({ atMs: BigInt(r.at), price: BigInt(r.price) });
      }
    }
  }

  /** The word this seat signed for a round before a restart, from its store (kanban #1844), or null. */
  keptWord(id) {
    if (!this.db) return null;
    try {
      const r = this.db.prepare('SELECT word FROM drawn_words WHERE round_hex = ?').get(id);
      if (!r) return null;
      const j = JSON.parse(r.word), w = wordFromJson(j);
      if (!w) return null;
      if (j.priceToBeat !== null && j.priceToBeat !== undefined) w.priceToBeat = BigInt(j.priceToBeat);
      if (j.endPrice !== null && j.endPrice !== undefined) w.endPrice = BigInt(j.endPrice);
      if (j.label) w.label = j.label;
      return w;
    } catch { return null; }
  }

  async read() {
    let cents = null;
    try { cents = await this.readPrice(); } catch { cents = null; }
    const at = this.now();
    // a reader answers cents, or { cents, atMs } (the seat's feed: the exchange ticker's last trade)
    if (cents && typeof cents === 'object') cents = cents.cents;
    if (Number.isFinite(Number(cents)) && Number(cents) > 0) {
      const s = { atMs: BigInt(at), price: BigInt(Math.round(Number(cents))) };
      this.samples.push(s);
      // kanban #1844: kept in the store as it is taken, so a restart loses no window
      if (this.db) try { this.db.prepare('INSERT OR REPLACE INTO drawn_samples (at_ms, price) VALUES (?, ?)').run(at, String(s.price)); } catch { /* memory still holds it */ }
    }
    // kanban #2186: kept from the earlier of KEEP_MS ago and a minute before the start of every round still due, and the reading in
    // force at that moment (the last one at or before it) kept too - upDownPrices needs a reading in force a minute before the start
    const keepFrom = this.keepFrom(at);
    let cut = 0;
    while (cut + 1 < this.samples.length && this.samples[cut + 1].atMs <= keepFrom) cut++;
    if (cut > 0) this.samples.splice(0, cut);
    if (this.db) try { this.db.prepare('DELETE FROM drawn_samples WHERE at_ms < (SELECT MAX(at_ms) FROM drawn_samples WHERE at_ms <= ?)').run(Number(keepFrom)); } catch { /* pruned next read */ }
  }

  /** The earliest time a reading is still needed at (kanban #2186): KEEP_MS ago, or a minute before the start of a round still due. */
  keepFrom(at) {
    let from = BigInt(at - KEEP_MS);
    let due = [];
    try { due = this.due() || []; } catch { due = []; }
    for (const r of due) {
      const start = r && r.window && typeof r.window.startMs === 'bigint' ? r.window.startMs - UP_DOWN_AVERAGE_MS : null;
      if (start !== null && start < from) from = start;
    }
    return from;
  }

  /** This seat's word on a round: signed once, once its window has ended; null when it is not drawn or cannot read the outcome. */
  wordFor(roundId, window) {
    const id = toHex(roundId);
    if (this.words.has(id)) return this.words.get(id);
    const kept = this.keptWord(id);
    if (kept) { this.words.set(id, kept); return kept; }
    const drawn = this.attestorsFor(roundId);
    if (!drawn || !drawn.includes(this.selfKey)) return null;
    if (BigInt(this.now()) < window.endMs + BigInt(SETTLE_MS)) return null;
    // kanban #2461: only a window this seat read is signed - never its end price from a reading before a downtime
    const out = windowRead(this.samples, window) ? upDownOutcome(this.samples, window) : { ok: false };
    if (!out.ok) { this.words.set(id, null); return null; }
    const body = { roundId, outcome: out.outcome, observedAtMs: window.endMs };
    let word = { body, key: this.selfKey, signature: toHex(this.sign(attestationBodyId(body))), priceToBeat: out.priceToBeat, endPrice: out.endPrice, label: out.label };
    // kanban #1844: written before it is served; a word already kept for the round (signed before a restart) is the one that stands
    if (this.db) {
      try { this.db.prepare('INSERT OR IGNORE INTO drawn_words (round_hex, word) VALUES (?, ?)').run(id, JSON.stringify(wordToJson(word))); } catch { /* served from memory */ }
      word = this.keptWord(id) || word;
    }
    this.words.set(id, word);
    return word;
  }

  /** GET /attestation-word's answer for a round, or null. */
  served(roundId) { const w = this.words.get(toHex(roundId)); return w ? wordToJson(w) : null; }

  /** One pass: every due round's word made, the others' asked for, and an attestation of 5 held. */
  async pass() {
    const done = [];
    for (const r of this.due()) {
      const id = toHex(r.roundId);
      if (this.held.has(id)) continue;
      // COMBINED, STILL DELIVERING (kanban #1989): the attestation was held here, but a settlement or drawn seat did not take the one
      // push (restarting, past the 8 s, 404/409 at that moment) - and no seat pulls outcomes, so it would stay OPEN and turn VOID at the
      // deadline while the others are FINAL. Handed again on every pass while the round is due, to the seats that have not taken it
      if (this.delivering.has(id)) {
        try { const got = await this.hold(this.delivering.get(id), r.roundId); if (got === true || (got && got.delivered)) { this.delivering.delete(id); this.held.add(id); } } catch { /* asked again next pass */ }
        continue;
      }
      const mine = this.wordFor(r.roundId, r.window);
      if (!mine) continue;
      const drawn = this.attestorsFor(r.roundId) || [];
      const theirs = await Promise.all((this.peersFor(r.roundId) || []).map(async (base) => {
        try {
          const res = await this.fetcher(`${String(base).replace(/\/+$/, '')}/attestation-word?round=${id}`, { signal: AbortSignal.timeout(ASK_MS) });
          // kanban #2458: a word is under 1 kB - an answer past WORD_ANSWER_MAX counts as no word, like a 404
          return res.status === 200 ? wordFromJson(await jsonUpTo(res, WORD_ANSWER_MAX)) : null;
        } catch { return null; }
      }));
      // each word checked with the drawn attestors' scheme (BIP-340, kanban #1487): a junk signature counts for nothing and never replaces a good one
      const got = combine([mine, ...theirs], { attestors: drawn, threshold: this.threshold, verify: this.verify });
      if (!got) continue;
      try {
        const h = await this.hold(got.bytes, r.roundId);
        if (h === true || (h && h.held)) {
          if (h === true || h.delivered) this.held.add(id); else this.delivering.set(id, got.bytes);
          done.push({ round: id, signers: got.signers, outcome: got.body.outcome });
        }
      } catch { /* asked again next pass */ }
    }
    for (const id of [...this.words.keys()].slice(0, Math.max(0, this.words.size - 512))) this.words.delete(id);
    for (const id of [...this.delivering.keys()].slice(0, Math.max(0, this.delivering.size - 512))) this.delivering.delete(id);
    return done;
  }
}
