// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// RESULTS ON NOSTR (feature 2, docs/PLATFORM-RESEARCH.md: "nodes publish what is already signed; the relay accepts the
// event kind"). When a round's settlement is ACCEPTED at this node, the node signs ONE Nostr event with the round's public result -
// the game, the round, its federation and stake, each entry's display name, player key, outcome, score or pick, rank and the
// share of the pool its settlement paid, the FINAL time and the settlement txid(s) - so anyone can follow a node's npub, and a
// player's win travels without our page. Nothing in it is new or secret: every field is served already at /api/round-result,
// /lock-settlement and /round; the event adds a signature by the node's own key and a place to find it.
//
// THE KIND: 30762, a parameterized replaceable event (NIP-01: 30000-39999, newest per author, kind and `d`). Not 30078 (NIP-78
// app data is the players' encrypted seeds on our relay - a result is public and must not be mistaken for one) and not 31337
// (unregistered, but used by Zapstr for music tracks); 30762 is in no NIP's registry (nostr-protocol/nips README, read
// 2026-10-14). `d` = arena:result:<round id hex>, so a node publishes one result per round and a corrected one replaces it.
//
// THE KEY IS THE NODE'S IDENTITY (store.js nodeIdentity, round.identity: the key its receipts, results and adverts are signed
// with). A Nostr event id is sha256 of a JSON array starting `[0,"<pubkey>",` - no protocol digest is ever that preimage, and the
// content is built here from the node's own store, never handed in, so the key signs nothing a peer chose.
//
// PUBLISHING NEVER BLOCKS A SETTLEMENT: it runs on its own clock, after the fact, from what the store says is ACCEPTED. Each round
// is published once (the nostr_results row), to every relay in ARENA_NOSTR_PUBLISH, retried with backoff, at most `perMinute`
// events a minute, and given up after `maxAttempts`. The event is built ONCE and kept: /nostr-results serves those exact bytes,
// published or not, so a client can check the id and the signature against the node's key.
import WebSocket from 'ws';
import { schnorr } from '@noble/curves/secp256k1.js';
import { eventId } from './nostr-relay.js';

export const RESULT_KIND = 30762;
export const RESULT_D_PREFIX = 'arena:result:';
export const RESULT_CONTENT_VERSION = 1;
const HEX64 = /^[0-9a-f]{64}$/;
const BACKOFF_MS = 30000, BACKOFF_MAX_MS = 3600000;

const hexOf = (b) => Buffer.from(b).toString('hex');
const bytesOf = (h) => Uint8Array.from(Buffer.from(h, 'hex'));
const str = (v) => (v === null || v === undefined ? null : String(v));

/**
 * THE CONTENT, CANONICAL: the same result gives the same bytes on every call and every node - keys in a fixed order, amounts as
 * decimal strings (msat exceed 2^53), entries in rank order, then the unranked by player key. A field a round does not have is
 * null, never left out, so two events of the same round differ only where the result does.
 */
export function resultContent(r) {
  if (!r || !HEX64.test(String(r.round || ''))) throw new Error('a result names its round in 64 hex');
  if (!r.game || !r.game.name || !HEX64.test(String(r.game.id || ''))) throw new Error('a result names its game: a name and a 64-hex id');
  const entries = (r.entries || []).map((e) => ({
    entry: String(e.entry), player: String(e.player), name: String(e.name ?? ''), federation: str(e.federation),
    outcome: str(e.outcome), score: e.score === null || e.score === undefined ? null : Number(e.score),
    pick: e.pick === null || e.pick === undefined ? null : Number(e.pick),
    rank: e.rank === null || e.rank === undefined ? null : Number(e.rank), payoutMsat: String(e.payoutMsat ?? '0'),
  }));
  entries.sort((a, b) => (a.rank === null) - (b.rank === null) || (a.rank ?? 0) - (b.rank ?? 0)
    || (a.player < b.player ? -1 : a.player > b.player ? 1 : 0) || (a.entry < b.entry ? -1 : a.entry > b.entry ? 1 : 0));
  return JSON.stringify({
    v: RESULT_CONTENT_VERSION,
    game: { name: String(r.game.name), id: String(r.game.id) },
    round: String(r.round),
    federation: str(r.federation),
    stakeMsat: String(r.stakeMsat ?? '0'),
    finalAt: new Date(Number(r.finalMs)).toISOString(),
    settlement: (r.settlement || []).map((s) => ({ federation: str(s.federation), txid: str(s.txid) })),
    outcome: r.outcome ? { index: Number(r.outcome.index), label: str(r.outcome.label) } : null,
    entries,
  });
}

/** The tags: `d` (one per round), `t` the game's name, `g` its id, and NIP-31's `alt` for a client that does not know the kind. */
export function resultTags(r) {
  return [['d', `${RESULT_D_PREFIX}${r.round}`], ['t', String(r.game.name)], ['g', String(r.game.id)],
    ['alt', `Bitcoin Arena result: ${r.game.name} round ${String(r.round).slice(0, 16)}`]];
}

/**
 * THE SIGNED EVENT (NIP-01): created_at is the FINAL time, the id the hash NIP-01 names, the signature BIP-340 by `secret` with a
 * zero aux - deterministic, so the same result and key give the same event, byte for byte, after a restart too.
 */
export function buildResultEvent({ result, secret }) {
  const e = { pubkey: hexOf(schnorr.getPublicKey(secret)), created_at: Math.floor(Number(result.finalMs) / 1000), kind: RESULT_KIND,
    tags: resultTags(result), content: resultContent(result) };
  e.id = eventId(e);
  e.sig = hexOf(schnorr.sign(bytesOf(e.id), secret, new Uint8Array(32)));
  return { id: e.id, pubkey: e.pubkey, created_at: e.created_at, kind: e.kind, tags: e.tags, content: e.content, sig: e.sig };
}

/** The relays named in ARENA_NOSTR_PUBLISH (comma list), wss:// - or ws:// for a relay on the same machine; none: publishing is off. */
export const publishRelays = (v = process.env.ARENA_NOSTR_PUBLISH || '') =>
  [...new Set(String(v).split(',').map((u) => u.trim()).filter((u) => /^wss?:\/\/[^\s]+$/.test(u)))];

/**
 * THE ROUNDS WHOSE SETTLEMENT THIS NODE HOLDS ACCEPTED SINCE `sinceMs` AND HAS NO EVENT FOR YET: a round in one federation by its
 * lock_settlements row, a round that takes any federation by its fed_lock_settlements rows (the caller asks settlementState
 * whether every one of them is ACCEPTED). Hex ids, oldest first, at most `limit`.
 */
export function acceptedWithoutEvent(db, sinceMs, limit = 50) { return acceptedNotIn(db, 'nostr_results', sinceMs, limit); }

/**
 * The same rounds, not yet in `table` (its `round_id` the hex id): how the badge book (nostr-badges.js) finds each newly
 * ACCEPTED round on the same clock as the results, in its own ledger. `table` is one of this package's own names, never input.
 */
export function acceptedNotIn(db, table, sinceMs, limit = 50) {
  if (!/^[a-z_]+$/.test(table)) throw new Error('a table name is lowercase letters');
  return db.prepare(`SELECT lower(hex(round_id)) AS rid, MAX(made_ms) AS at FROM (
      SELECT round_id, made_ms FROM lock_settlements WHERE state = 'ACCEPTED' AND made_ms >= ?
      UNION ALL SELECT round_id, made_ms FROM fed_lock_settlements WHERE state = 'ACCEPTED' AND made_ms >= ?)
    WHERE lower(hex(round_id)) NOT IN (SELECT round_id FROM ${table}) GROUP BY round_id ORDER BY at LIMIT ?`)
    .all(Number(sinceMs), Number(sinceMs), limit).map((r) => r.rid);
}

/** Send `events` to one relay and gather its OK for each: Map id -> { ok, why }; an id with no answer in time is left out. */
export async function sendToRelay(url, events, { connect = (u) => new WebSocket(u), timeoutMs = 10000 } = {}) {
  const answers = new Map();
  if (!events.length) return answers;
  let ws;
  try { ws = connect(url); } catch (e) { return answers; }
  const want = new Set(events.map((e) => e.id));
  await new Promise((resolve) => {
    const done = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(done, timeoutMs);
    ws.on('error', done);
    ws.on('close', done);
    ws.on('open', () => { for (const e of events) { try { ws.send(JSON.stringify(['EVENT', e])); } catch { /* closed under us */ } } });
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(String(raw)); } catch { return; }
      if (!Array.isArray(m) || m[0] !== 'OK' || !want.has(m[1])) return;
      answers.set(m[1], { ok: m[2] === true, why: String(m[3] ?? '') });
      want.delete(m[1]);
      if (!want.size) done();
    });
  });
  try { ws.terminate(); } catch { /* gone */ }
  return answers;
}

/**
 * ONE PUBLISHING PASS over kept rows `{ event, relays, attempts }` (a result's, a badge's): each relay is sent what it has not
 * answered yet, all relays at once; an OK true (or "duplicate:") is done, an OK false is that relay's refusal, kept and not
 * asked again; no answer in time is asked again later. Each row's `relays` is filled in place, and each answers what to
 * write back: `{ publishedMs, nextMs, why, attempts, done }` - published once every relay answered, else again after a backoff
 * that doubles from 30 s to an hour (`done` false: the caller says so, or gives up after its maxAttempts).
 */
export async function publishPass(rows, relays, { connect, timeoutMs = 10000, now = () => Date.now(), maxAttempts = 10 } = {}) {
  await Promise.all(relays.map(async (url) => {
    const owed = rows.filter((r) => !r.relays[url]);
    const answers = await sendToRelay(url, owed.map((r) => r.event), { connect, timeoutMs });
    for (const r of owed) {
      const a = answers.get(r.event.id);
      if (a) r.relays[url] = a.ok || /^duplicate:/.test(a.why) ? 'ok' : `refused: ${a.why}`.slice(0, 200);
    }
  }));
  const after = now();
  return rows.map((r) => {
    const attempts = r.attempts + 1;
    if (relays.every((u) => r.relays[u])) {
      const refused = relays.filter((u) => r.relays[u] !== 'ok');
      return { done: true, publishedMs: after, nextMs: 0, attempts, refused, why: refused.length ? `refused by ${refused.join(', ')}` : null };
    }
    const waitMs = Math.min(BACKOFF_MS * 2 ** (attempts - 1), BACKOFF_MAX_MS);
    const silent = relays.filter((u) => !r.relays[u]);
    return { done: false, publishedMs: null, nextMs: after + waitMs, attempts, waitMs,
      why: `no answer from ${silent.join(', ')} (attempt ${attempts} of ${maxAttempts})` };
  });
}

/**
 * THE NODE'S RESULT BOOK AND ITS PUBLISHER.
 *   db          the round store's database (the nostr_results table is made here)
 *   secret      the node's identity secret (32 bytes)
 *   resultOf    hex round id -> { ok: true, result } | { ok: false, status, why }: the public result, from the node's store
 *   relays      where to publish (publishRelays()); none: the book serves the door and nothing is sent
 *   settled     hex round id -> whether its settlement stands ACCEPTED (round.settlementState)
 * Answers { eventFor(ridHex), row(ridHex), tick(), start(), stop() }.
 */
export function nostrResults({ db, secret, resultOf, relays = [], settled = () => true, perMinute = 30, tickMs = 20000, timeoutMs = 10000,
  maxAttempts = 10, lookbackMs = 24 * 3600 * 1000, now = () => Date.now(), connect, log = (l) => console.log(l) } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS nostr_results (round_id TEXT PRIMARY KEY, event TEXT NOT NULL, made_ms INTEGER NOT NULL,
    published_ms INTEGER, attempts INTEGER NOT NULL DEFAULT 0, next_ms INTEGER NOT NULL DEFAULT 0, relays TEXT NOT NULL DEFAULT '{}', why TEXT)`);
  const keep = db.prepare('INSERT OR IGNORE INTO nostr_results (round_id, event, made_ms) VALUES (?, ?, ?)');
  const get = db.prepare('SELECT * FROM nostr_results WHERE round_id = ?');
  const due = db.prepare('SELECT * FROM nostr_results WHERE published_ms IS NULL AND attempts < ? AND next_ms <= ? ORDER BY made_ms, round_id LIMIT ?');
  const mark = db.prepare('UPDATE nostr_results SET published_ms = ?, attempts = ?, next_ms = ?, relays = ?, why = ? WHERE round_id = ?');
  const startedMs = now();
  const notOurs = new Set();                     // rounds whose result this node cannot say (a game it does not host): not asked again
  const sentAt = [];                             // when each event was sent, for the per-minute bound
  let timer = null, busy = false, stopped = false;

  const rowOf = (r) => (r ? { round: r.round_id, event: JSON.parse(r.event), madeMs: Number(r.made_ms),
    publishedMs: r.published_ms === null ? null : Number(r.published_ms), attempts: Number(r.attempts), nextMs: Number(r.next_ms),
    relays: JSON.parse(r.relays), why: r.why } : null);

  /** The event of a round: the one kept, else built now from its ACCEPTED settlement and kept - the first one built stands. */
  const eventFor = (ridHex) => {
    const rid = String(ridHex || '').toLowerCase();
    if (!HEX64.test(rid)) return { ok: false, status: 400, why: 'a result is asked for by a 64-hex round id' };
    const held = get.get(rid);
    if (held) return { ok: true, event: JSON.parse(held.event), row: rowOf(held) };
    let got;
    try { got = resultOf(rid); } catch (e) { got = { ok: false, status: 500, why: e.message }; }
    if (!got || !got.ok) return { ok: false, status: (got && got.status) || 409, why: (got && got.why) || 'no result' };
    const event = buildResultEvent({ result: got.result, secret });
    keep.run(rid, JSON.stringify(event), now());
    const row = rowOf(get.get(rid));
    return { ok: true, event: row.event, row };
  };

  const tick = async () => {
    if (busy || stopped) return { sent: 0 };
    busy = true;
    try {
      // 1. EVERY NEWLY ACCEPTED ROUND GETS ITS EVENT, kept (looked back a day before this start: switching publishing on
      // publishes yesterday's rounds, not the whole archive)
      for (const rid of acceptedWithoutEvent(db, startedMs - lookbackMs)) {
        if (notOurs.has(rid) || !settled(rid)) continue;
        const got = eventFor(rid);
        if (!got.ok && got.status === 404) notOurs.add(rid);
      }
      if (!relays.length) return { sent: 0 };
      // 2. THE BOUND: at most perMinute events sent in any minute
      const t = now();
      while (sentAt.length && sentAt[0] <= t - 60000) sentAt.shift();
      const budget = Math.max(0, perMinute - sentAt.length);
      if (!budget) return { sent: 0 };
      const rows = due.all(maxAttempts, t, budget).map(rowOf);
      if (!rows.length) return { sent: 0 };
      for (const _ of rows) sentAt.push(t);
      // 3. EACH RELAY IS SENT WHAT IT HAS NOT ANSWERED YET (publishPass)
      const outcomes = await publishPass(rows, relays, { connect, timeoutMs, now, maxAttempts });
      rows.forEach((r, i) => {
        const o = outcomes[i];
        mark.run(o.publishedMs, o.attempts, o.nextMs, JSON.stringify(r.relays), o.why, r.round);
        if (o.done) log(`[nostr] round ${r.round.slice(0, 16)} result ${r.event.id.slice(0, 16)} published: ${relays.length - o.refused.length} of ${relays.length} relays took it`);
        else log(`[nostr] round ${r.round.slice(0, 16)} result not published yet: ${o.why}${o.attempts < maxAttempts ? `; again in ${Math.round(o.waitMs / 1000)} s` : '; given up'}`);
      });
      return { sent: rows.length };
    } catch (e) {
      log(`[nostr] ${e.message}`);
      return { sent: 0, why: e.message };
    } finally { busy = false; }
  };

  return {
    eventFor,
    row: (ridHex) => rowOf(get.get(String(ridHex || '').toLowerCase())),
    tick,
    start() {
      if (timer || !relays.length) return;
      timer = setInterval(() => { tick().catch(() => {}); }, tickMs);
      if (timer.unref) timer.unref();
    },
    stop() { stopped = true; if (timer) clearInterval(timer); timer = null; },
  };
}
