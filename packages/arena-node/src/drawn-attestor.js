// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SEAT AS ONE OF ITS ROUND'S DRAWN ATTESTORS (kanban #630, protocol 21; 2026-10-24: "Atteststiom should also be pre deterministic
// and be drawed randomly, not a fixed set of nodes ... 5 of 7 is needed"). A game whose manifest names a draw (manifest.js attestDraw) has
// no attestor daemons: each round's 7 attestors are node keys of its census (sortition.js drawAttestors), and a seat drawn for a round
// does what arena-attestor's daemon does for a fixed key:
//
//   READ.    Its own price, every READ_MS (the seat's feed read, cents), kept for KEEP_MS - a window and the minute before it.
//   SIGN.    Once the round's window has ended (+ SETTLE_MS), the market's rule over its own readings (up-down.js upDownOutcome) and
//            the attestation body {round, outcome, observed_at = the window's end}, signed BIP-340 with its node key. One word a
//            round: kept, never signed again differently.
//   SERVE.   GET /attestation-word?round= answers that word (wordToJson), so the other drawn seats can combine it.
//   COMBINE. It asks the round's other drawn attestors for theirs; once 5 of the 7 signed one body, that attestation is held here
//            (the /outcome intake, which checks it against the draw) and handed to every seat of the round.
//
// A MARKET WITH ITS OWN SOURCE (kanban #920) is the same but for READ and the rule: at the window's end the seat makes the market's reads and runs its code or field rule
// in the market sandbox (`runSource`, off the node's thread, so this pass waits and the seat does not). A "rises" rule reads once more when its window opens (`opening`).
//
// Honest seats whose readings agree sign the same bytes. Seats that read a near tie differently sign different bodies; only 5 over
// ONE body make an attestation, and a round with none by its deadline is refunded as any unattested market is.
import { attestationBodyId } from '../../arena-protocol/src/attested.js';
import { upDownOutcome } from '../../arena-protocol/src/up-down.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { combine, wordToJson, wordFromJson } from '../../arena-attestor/src/attestor.js';
import { MARKET_RULE } from '../../arena-protocol/src/manifest.js';
import { outcomeIndex } from '../../arena-protocol/src/market-rule.js';
import { jsonUpTo } from './body-read.js';
// the most of one drawn seat's GET /attestation-word answer that is read (kanban #2458)
const WORD_ANSWER_MAX = 16 * 1024;

export const READ_MS = 10000;
export const KEEP_MS = 40 * 60 * 1000;
export const SETTLE_MS = 5000;
export const ASK_MS = 4000;

/**
 * THE DRAWN ATTESTOR'S STORE in the seat's database (kanban #1376, server.js; kanban #1844): the words it signed and a "rises" market's
 * start value, each kept once (INSERT OR IGNORE: the first stands), read back after a restart.
 */
export function drawnStoreOf(db) {
  db.exec('CREATE TABLE IF NOT EXISTS drawn_words (round TEXT PRIMARY KEY, word TEXT NOT NULL); CREATE TABLE IF NOT EXISTS drawn_starts (round TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const big = (k, v) => (typeof v === 'bigint' ? { $big: String(v) } : v), unbig = (k, v) => (v && typeof v === 'object' && typeof v.$big === 'string' ? BigInt(v.$big) : v);
  const wordOf = (id) => { const r = db.prepare('SELECT word FROM drawn_words WHERE round = ?').get(id); return r ? JSON.parse(r.word) : null; };
  return {
    word: wordOf,
    keepWord: (id, json) => { db.prepare('INSERT OR IGNORE INTO drawn_words (round, word) VALUES (?, ?)').run(id, JSON.stringify(json)); return wordOf(id); },
    start: (id) => { const r = db.prepare('SELECT value FROM drawn_starts WHERE round = ?').get(id); return r ? JSON.parse(r.value, unbig) : undefined; },
    keepStart: (id, v) => { db.prepare('INSERT OR IGNORE INTO drawn_starts (round, value) VALUES (?, ?)').run(id, JSON.stringify(v, big)); },
  };
}

export class DrawnAttestor {
  /**
   * `readPrice()` cents or null; `selfKey` this seat's node key (hex); `sign(digest)` its BIP-340 signature (bytes);
   * `attestorsFor(roundIdBytes)` the round's 7 drawn keys (hex) or null; `peersFor(roundIdBytes)` the drawn attestors' base URLs
   * (this seat's left out); `due()` the rounds to attest now, [{ roundId (bytes), window { startMs, endMs } }]; `hold(bytes, roundId)`
   * takes a combined attestation (this seat's intake, then every seat); `threshold` 5. A due round with `source` and `outcomes` is a market with its own source:
   * `runSource(source, market)` answers { ok, out }, and `opening()` names the source rounds whose window has just opened.
   */
  constructor({ readPrice, selfKey, sign, verify, attestorsFor, peersFor, due, hold, threshold = 5, fetcher = (u, o) => fetch(u, o), now = () => Date.now(), runSource = null, opening = () => [], store = null, db = null }) {
    if (typeof verify !== 'function') throw new Error('a drawn attestor needs verify(signature, bodyId, key): the drawn keys\' BIP-340 check (kanban #1487)');
    // `store` (kanban #1376, audit 2 #1204 MKT-3): { word(id), keepWord(id, json) -> the json now kept, start(id), keepStart(id, value) } - the seat's
    // database, so a restart serves the word it signed and never signs another from a later read of the source
    // `db` the seat's store (node:sqlite), where the readings are kept across a restart (kanban #1844)
    // (a `db` with no `store` keeps its words there too: drawnStoreOf, as server.js builds it)
    if (!store && db) store = drawnStoreOf(db);
    Object.assign(this, { readPrice, selfKey, sign, verify, attestorsFor, peersFor, due, hold, threshold, fetcher, now, runSource, opening, store, db });
    this.starts = new Map();    // round hex -> a "rises" market's value when its window opened
    this.samples = [];          // [{ atMs, price }] BigInt, this seat's own readings
    this.words = new Map();     // round hex -> this seat's word
    this.held = new Set();      // round hex: an attestation of it is held - nothing more to do
    // THE READINGS AND WORDS IN THE SEAT'S STORE (kanban #1844, state audit 2026-11-12): kept in memory only, a seat restarted after
    // its round's window ended (a host reboot, a roll of the seats) came back with no reading before the window's start and never
    // signed it - three of seven drawn seats restarted together and the market went VOID although all seven read the window. As the
    // fixed daemon keeps them on disk (arena-attestor.mjs SAMPLES_FILE), each reading is written as it is taken and the last KEEP_MS
    // read back here. (2.0: the signed word is kept through `store` already, kanban #1376.)
    if (db) {
      db.exec('CREATE TABLE IF NOT EXISTS drawn_samples (at_ms INTEGER PRIMARY KEY, price TEXT NOT NULL)');
      for (const r of db.prepare('SELECT at_ms AS at, price FROM drawn_samples WHERE at_ms >= ? ORDER BY at_ms').all(this.now() - KEEP_MS)) {
        this.samples.push({ atMs: BigInt(r.at), price: BigInt(r.price) });
      }
    }
  }

  /** The word kept for a round: memory, else the store (after a restart). */
  #kept(id) {
    if (this.words.has(id)) return this.words.get(id);
    if (!this.store) return undefined;
    let j = null; try { j = this.store.word(id); } catch { j = null; }
    const w = j ? wordFromJson(j) : null;
    if (w) { this.words.set(id, w); return w; }
    return undefined;
  }
  /** A word signed now, kept before it is served: the store's first stands (INSERT OR IGNORE), so two signings of one round serve one word. */
  #keep(id, word) {
    if (this.store) { try { const j = this.store.keepWord(id, wordToJson(word)); const w = j ? wordFromJson(j) : null; if (w) word = w; } catch { /* memory only */ } }
    this.words.set(id, word);
    return word;
  }
  #start(id) {
    if (this.starts.has(id)) return this.starts.get(id);
    if (!this.store) return undefined;
    let v; try { v = this.store.start(id); } catch { v = undefined; }
    if (v !== undefined && v !== null) { this.starts.set(id, v); return v; }
    return undefined;
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
    const keepFrom = BigInt(at - KEEP_MS);
    while (this.samples.length && this.samples[0].atMs < keepFrom) this.samples.shift();
    if (this.db) try { this.db.prepare('DELETE FROM drawn_samples WHERE at_ms < ?').run(at - KEEP_MS); } catch { /* pruned next read */ }
    if (this.runSource) {
      for (const r of this.opening()) {
        const id = toHex(r.roundId);
        if (r.source.rule !== MARKET_RULE.RISES || this.#start(id) !== undefined) continue;
        const got = await this.runSource({ ...r.source, rule: MARKET_RULE.VALUE }, { outcomes: r.outcomes }, r.listed);
        if (got.ok) { this.starts.set(id, got.out); if (this.store) try { this.store.keepStart(id, got.out); } catch { /* memory only */ } }
      }
    }
  }

  /** This seat's word on a market with its own source: as wordFor, the outcome from the source. A read that fails is tried again on the next pass. */
  async wordForSource(r) {
    const id = toHex(r.roundId);
    { const k = this.#kept(id); if (k !== undefined) return k; }
    const drawn = this.attestorsFor(r.roundId);
    if (!drawn || !drawn.includes(this.selfKey)) return null;
    if (BigInt(this.now()) < r.window.endMs + BigInt(SETTLE_MS)) return null;
    if (r.source.rule === MARKET_RULE.RISES && this.#start(id) === undefined) return null;
    const got = await this.runSource(r.source, { outcomes: r.outcomes, start: this.#start(id) }, r.listed);
    const outcome = got.ok ? outcomeIndex(got.out, r.outcomes) : null;
    if (outcome === null) return null;
    const body = { roundId: r.roundId, outcome, observedAtMs: r.window.endMs };
    const word = { body, key: this.selfKey, signature: toHex(this.sign(attestationBodyId(body))) };
    return this.#keep(id, word);
  }

  /** This seat's word on a round: signed once, once its window has ended; null when it is not drawn or cannot read the outcome. */
  wordFor(roundId, window) {
    const id = toHex(roundId);
    { const k = this.#kept(id); if (k !== undefined) return k; }
    const drawn = this.attestorsFor(roundId);
    if (!drawn || !drawn.includes(this.selfKey)) return null;
    if (BigInt(this.now()) < window.endMs + BigInt(SETTLE_MS)) return null;
    const out = upDownOutcome(this.samples, window);
    if (!out.ok) { this.words.set(id, null); return null; }
    const body = { roundId, outcome: out.outcome, observedAtMs: window.endMs };
    const word = { body, key: this.selfKey, signature: toHex(this.sign(attestationBodyId(body))), priceToBeat: out.priceToBeat, endPrice: out.endPrice, label: out.label };
    return this.#keep(id, word);
  }

  /** GET /attestation-word's answer for a round, or null. */
  served(roundId) { const w = this.#kept(toHex(roundId)); return w ? wordToJson(w) : null; }

  /** One pass: every due round's word made, the others' asked for, and an attestation of 5 held. */
  async pass() {
    const done = [];
    const dueNow = this.due();
    for (const r of dueNow) {
      const id = toHex(r.roundId);
      if (this.held.has(id)) continue;
      const mine = r.source ? await this.wordForSource(r) : this.wordFor(r.roundId, r.window);
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
      try { if (await this.hold(got.bytes, r.roundId)) { this.held.add(id); done.push({ round: id, signers: got.signers, outcome: got.body.outcome }); } } catch { /* asked again next pass */ }
    }
    // a round still due keeps its word in memory (kanban #1376); the store keeps every one
    const due = new Set(dueNow.map((r) => toHex(r.roundId)));
    for (const id of [...this.words.keys()].filter((k) => !due.has(k)).slice(0, Math.max(0, this.words.size - 512))) this.words.delete(id);
    return done;
  }
}
