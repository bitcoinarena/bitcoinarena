// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// OUR OWN NOSTR RELAY (2026-10-10: "ours and a few public ones"): the relay the page's Nostr login writes
// to first. NIP-01 (EVENT, REQ, CLOSE; OK, EOSE, NOTICE, CLOSED), NIP-11 (its information document), replaceable and
// parameterized-replaceable events kept newest-only (NIP-01), ephemeral events passed on and never kept. It takes only what
// the game needs, so it is not a general relay anybody can fill:
//   0      a profile (the name and picture the lobby shows)
//   10002  a relay list (NIP-65: where a player's other events live)
//   30078  app data (NIP-78): the player's game seed, NIP-44-encrypted to the player's own key - only they can read it
//   24133  NIP-46 remote signing (a bunker or Amber talking to the page): ephemeral, passed on, never kept
//   22242  NIP-42 auth: ephemeral
//   13194, 23194, 23195  NIP-47 wallet connect: a wallet's info (kept, replaceable), requests and answers (ephemeral)
//   30762  a node's signed round result (feature 2, nostr-results.js): public, parameterized replaceable - newest per
//          node and `d` (arena:result:<round id>) - checked like every other kind
//   30009, 8  a node's NIP-58 badges (nostr-badges.js): its badge definitions (parameterized replaceable, newest per
//          node and `d`) and its badge awards (regular events, each kept) - a player's badges are found by `#p`
// Every event's id is recomputed and its signature checked (BIP-340) before anything is kept or passed on.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { WebSocketServer } from 'ws';
import { schnorr } from '@noble/curves/secp256k1.js';

export const RELAY_KINDS = Object.freeze([0, 10002, 30078, 24133, 22242, 13194, 23194, 23195, 30762, 30009, 8, 9735]);   // + NIP-47 (wallet connect), + round results and NIP-58 badges, + NIP-57 zap receipts
const MAX_EVENT_BYTES = 64 * 1024, MAX_SUBS = 20, MAX_FILTERS = 10, MAX_LIMIT = 500, FUTURE_S = 900;
// THE RELAY IS NOT ANYBODY'S DISK (kanban #1513, #1489 r1-nostr-3): the only limit was 60 messages per 10 s per socket, and sockets
// are free, so one fresh key kept any number of events (kind 8, 9735, or 30078/30762/30009 under new `d`s, up to 64 KB each). Now:
//   - per author at most AUTHOR_EVENTS events and AUTHOR_BYTES bytes; a new one past that pushes out that author's OWN oldest
//     (nobody else's), so a node's newest round results and badges are always kept;
//   - in total at most TOTAL_EVENTS events and TOTAL_BYTES bytes; bytes are bytes on disk (#1704); one that replaces or rolls out its
//     author's own adds nothing and is kept (kanban #1769); one that grows a full store makes room by FAIR SHARE (kanban #1943, #1983, below)
//     and is refused ('blocked: the relay is full') only when no one holds more than its author;
//   (no cap on sockets per address: behind the tunnel every player comes from the same local address; the quotas bound the disk);
//   - a REQ reads only the rows its ids/authors/kinds/since/until/tags select (SQL on indexed columns), at most SCAN_MOST index rows a filter (#1720).
const AUTHOR_EVENTS = 500, AUTHOR_BYTES = 4 * 1024 * 1024, TOTAL_EVENTS = 200000, TOTAL_BYTES = 512 * 1024 * 1024;
// WHAT AN EVENT COSTS IS WHAT IT TAKES ON DISK (kanban #1704, #1769, #1811, #1489 v1-refute-22): the quotas counted SQLite LENGTH(json) - characters,
// not bytes, so 3-byte UTF-8 content kept ~3x the quota - and left out the `tags` table (#1543), where every single-letter tag is a row with the
// event's id and two indexes: an event of 6000 empty one-letter tags counted 54 KB and took ~1 MB. Now each event row carries `size`: its JSON in
// UTF-8 bytes, plus the row and index overhead, plus each indexed tag row (TAG_ROW_BYTES + its value twice: the row and the (name, value) index),
// and every quota sums `size`. An event indexes at most MAX_TAG_ROWS distinct single-letter (name, value) pairs; one with more is refused (the
// game's events carry a handful: d, p, a, t, g, e; a NIP-65 list a few r).
const EVENT_ROW_BYTES = 320, TAG_ROW_BYTES = 160, MAX_TAG_ROWS = 100;
// kanban #1753: a tag that is not [name, value, ...] of strings is skipped (a store may hold one kept before the door refused it)
const indexedTags = (e) => { const seen = new Map(); for (const t of (Array.isArray(e.tags) ? e.tags : [])) if (Array.isArray(t) && t.length > 1 && typeof t[0] === 'string' && t[0].length === 1 && typeof t[1] === 'string') seen.set(`${t[0]}\u0000${t[1]}`, [t[0], t[1]]); return [...seen.values()]; };
const eventSize = (e, json, rows) => Buffer.byteLength(json) + EVENT_ROW_BYTES + 2 * Buffer.byteLength(isParam(e.kind) ? dTag(e) : '')
  + rows.reduce((s, [, v]) => s + TAG_ROW_BYTES + 2 * Buffer.byteLength(v), 0);
// A FULL RELAY MAKES ROOM BY FAIR SHARE, IT DOES NOT SHUT (kanban #1943, #1983, #1489 v1-refute-22-s2): a full relay refused every event that grew
// the store, and nothing ever aged out - so ~128 free keys, each inside its own quota, filled the total once and from then on every node's next
// round result (a new `d`), every new player's profile and seed, every new badge award was refused, after a retry and a restart too; and a node
// AT its own quota whose new result was longer than the one it rolled out (more players) was refused as well. Now the store has two pools:
// STATE (replaceable and parameterized kinds: profiles, relay lists, seeds, wallet info, round results, badge definitions - newest wins) and LOG
// (regular kinds, each kept: badge awards, zap receipts), each with a share of the total (LOG_SHARE; a pool may use more while the other does not
// need it). When an event would take the store past the total, room is made, one event at a time, in this order:
//   1. the OTHER pool, if it is over its share, gives back: the oldest event of its largest holder goes;
//   2. else, in the event's own pool, an author who holds MORE than the event's author then will (events or bytes, whichever is over) loses
//      its oldest - the largest such holder first, the most recently arrived of equal ones first;
//   3. else, a STATE event rolls out its own author's oldest STATE event (its newest wins, as under its own quota);
//   4. else it is refused ('blocked: the relay is full'): its author already holds as much as anybody - a LOG event never erases its own
//      author's older records to take more.
// So no stranger can shut the relay to anybody else: what free keys add is taken back from the largest holders first, which are theirs.
// Who holds what (per author and pool) is kept by triggers in temporary tables, rebuilt from the store at every start.
const LOG_SHARE = 0.5;
const POOL_SQL = (k) => `(CASE WHEN ${k} IN (0, 3) OR ${k} BETWEEN 10000 AND 19999 OR ${k} BETWEEN 30000 AND 39999 THEN 0 ELSE 1 END)`;   // 0 state, 1 log
const poolOf = (k) => (isReplaceable(k) || isParam(k) ? 0 : 1);
const SLOW_BYTES = 4 * 1024 * 1024;   // kanban #1542: the most one client may leave unread before it is dropped
const HARD_SLOW_BYTES = 2 * SLOW_BYTES;   // kanban #1717: past this backlog no message at all is queued; the client is dropped
// kanban #1871, #1904 (bypasses of #1542/#1717): the bound was per socket only, so N unread sockets of one stranger held N x ~4.7 MB.
// TOTAL_SLOW_BYTES bounds the unsent backlog of all clients together; past it the client with the largest backlog is dropped
// (an unread socket, never one that reads), so no per-address limit is needed (behind the tunnel every peer has one address).
const TOTAL_SLOW_BYTES = 2 * SLOW_BYTES;   // 8 MB: a socket that reads keeps almost nothing unsent (ws writes straight to the kernel)
const PINGS = 30;   // kanban #1871: pongs answered per socket per 10 s (a ping is no 'message', so it is outside the message budget)
const hex = (n) => new RegExp(`^[0-9a-f]{${n}}$`);
const HEX64 = hex(64), HEX128 = hex(128);
const isReplaceable = (k) => k === 0 || k === 3 || (k >= 10000 && k < 20000);
const isEphemeral = (k) => k >= 20000 && k < 30000;
const isParam = (k) => k >= 30000 && k < 40000;
const dTag = (e) => { const t = e.tags.find((x) => x[0] === 'd'); return t ? String(t[1] ?? '') : ''; };

/** The event's id as NIP-01 defines it: sha256 of [0, pubkey, created_at, kind, tags, content] as JSON. */
export const eventId = (e) => createHash('sha256').update(JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content])).digest('hex');

/** Whether an event is well formed, its id its own, its signature its author's: null, or why not. */
export function eventRefusal(e, { kinds = RELAY_KINDS, nowS = Math.floor(Date.now() / 1000) } = {}) {
  if (!e || typeof e !== 'object') return 'invalid: not an event';
  if (!HEX64.test(e.id || '') || !HEX64.test(e.pubkey || '') || !HEX128.test(e.sig || '')) return 'invalid: id, pubkey or sig';
  if (!Number.isInteger(e.kind) || e.kind < 0 || e.kind > 65535) return 'invalid: kind';
  if (!Number.isInteger(e.created_at) || e.created_at < 0) return 'invalid: created_at';
  // kanban #1960, #1994, #2009: every tag is a NON-EMPTY list of strings - an empty tag ([[]]) has no name, and it used to be stored and then
  // throw in the tag index, half handled (no quota, no replaceable drop, no fan-out) and fatal to the next start.
  if (!Array.isArray(e.tags) || !e.tags.every((t) => Array.isArray(t) && t.length >= 1 && t.every((x) => typeof x === 'string'))) return 'invalid: tags';
  if (typeof e.content !== 'string') return 'invalid: content';
  if (kinds && !kinds.includes(e.kind)) return `blocked: this relay keeps only kinds ${kinds.join(', ')} (the game's)`;
  if (e.created_at > nowS + FUTURE_S) return 'invalid: created_at is too far in the future';
  if (eventId(e) !== e.id) return 'invalid: the id is not the event\'s hash';
  let ok = false;
  const b = (h) => Uint8Array.from(Buffer.from(h, 'hex'));
  try { ok = schnorr.verify(b(e.sig), b(e.id), b(e.pubkey)); } catch { ok = false; }
  return ok ? null : 'invalid: the signature is not its author\'s';
}

/** Whether an event matches one NIP-01 filter. */
// A FILTER IS WHAT NIP-01 SAYS IT IS (kanban #1470, feedback #002 by Hexbox Tools 2026-11-11: a REQ with {"ids":5} called (5).includes, threw in the socket's
// message handler and took the relay down; the filter also stayed in the subscription and threw again on every later EVENT): ids and authors lists of hex
// (up to 64 characters, a prefix as NIP-01 allows), kinds a list of whole numbers, since, until and limit whole numbers, a #<letter> tag a list of strings.
// Answers null for a good filter, else why it is not one; a REQ with one bad filter is CLOSED.
const LIST_MOST = 500;
export function filterRefusal(f) {
  if (!f || typeof f !== 'object' || Array.isArray(f)) return 'a filter is an object';
  const hexList = (v) => Array.isArray(v) && v.length <= LIST_MOST && v.every((x) => typeof x === 'string' && /^[0-9a-f]{1,64}$/.test(x));
  if (f.ids !== undefined && !hexList(f.ids)) return 'ids is a list of hex';
  if (f.authors !== undefined && !hexList(f.authors)) return 'authors is a list of hex';
  if (f.kinds !== undefined && !(Array.isArray(f.kinds) && f.kinds.length <= LIST_MOST && f.kinds.every((k) => Number.isInteger(k) && k >= 0 && k <= 65535))) return 'kinds is a list of whole numbers';
  for (const k of ['since', 'until', 'limit']) if (f[k] !== undefined && !(Number.isInteger(f[k]) && f[k] >= 0)) return `${k} is a whole number`;
  for (const [k, v] of Object.entries(f)) if (k[0] === '#' && !(k.length === 2 && Array.isArray(v) && v.length <= LIST_MOST && v.every((x) => typeof x === 'string'))) return `${k.slice(0, 8)} is a list of strings`;
  return null;
}
export function matches(f, e) {
  if (f.ids && !(Array.isArray(f.ids) && f.ids.includes(e.id))) return false;
  if (f.authors && !(Array.isArray(f.authors) && f.authors.includes(e.pubkey))) return false;
  if (f.kinds && !(Array.isArray(f.kinds) && f.kinds.includes(e.kind))) return false;
  if (f.since !== undefined && e.created_at < f.since) return false;
  if (f.until !== undefined && e.created_at > f.until) return false;
  for (const [k, vals] of Object.entries(f)) {
    if (k[0] !== '#' || k.length !== 2 || !Array.isArray(vals)) continue;
    if (!e.tags.some((t) => t[0] === k[1] && vals.includes(t[1]))) return false;
  }
  return true;
}

// ONE EVENT IS NOT A STALL FOR EVERYONE (kanban #1752, #1489 r5-nostr-2): the fan-out ran matches() for every filter of every
// subscription of every socket, and matches() runs e.tags.some(vals.includes) - tags x values. Eight free sockets of 20 REQs x 10
// filters naming 500 #a values, and kind-8 events with 2000 `a` tags, held the relay's one event loop ~2.6 s per event. Now a filter
// is compiled into Sets once, when its REQ is accepted, the event's tags into Sets by letter once per event, and a tag check walks
// the smaller of the two sides: at most min(filter values, event values) lookups per tag, never their product.
export function compileFilter(f) {
  const set = (v) => (Array.isArray(v) ? new Set(v) : null);
  const tags = [];
  for (const [k, vals] of Object.entries(f)) if (k[0] === '#' && k.length === 2 && Array.isArray(vals)) tags.push([k[1], new Set(vals)]);
  return { ids: set(f.ids), authors: set(f.authors), kinds: set(f.kinds), since: f.since, until: f.until, tags };
}
export function eventTagSets(e) {
  const m = new Map();
  for (const t of e.tags) { if (t.length < 2) continue; let s = m.get(t[0]); if (!s) m.set(t[0], (s = new Set())); s.add(t[1]); }
  return m;
}
export function matchesCompiled(c, e, tagSets) {
  if (c.ids && !c.ids.has(e.id)) return false;
  if (c.authors && !c.authors.has(e.pubkey)) return false;
  if (c.kinds && !c.kinds.has(e.kind)) return false;
  if (c.since !== undefined && e.created_at < c.since) return false;
  if (c.until !== undefined && e.created_at > c.until) return false;
  for (const [letter, want] of c.tags) {
    const have = tagSets.get(letter);
    if (!have) return false;
    const [small, big] = have.size < want.size ? [have, want] : [want, have];
    let hit = false;
    for (const v of small) if (big.has(v)) { hit = true; break; }
    if (!hit) return false;
  }
  return true;
}

/**
 * THE RELAY: `{ port, host, dbPath }` ('' or ':memory:' keeps nothing on disk). Answers { port, close(), events() }.
 */
export async function startRelay({ port = 0, host = '127.0.0.1', dbPath = ':memory:', kinds = RELAY_KINDS, name = 'Bitcoin Arena relay',
  limits = {}, description = 'The game\'s own relay: profiles, relay lists, encrypted game seeds (NIP-78), remote signing (NIP-46), wallet connect (NIP-47), the nodes\' signed round results (kind 30762) and their badges (NIP-58: kinds 30009 and 8), and zap receipts (NIP-57: kind 9735). Nothing else is kept.' } = {}) {
  const db = new DatabaseSync(dbPath || ':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, pubkey TEXT, kind INTEGER, created_at INTEGER, d TEXT, json TEXT);
    CREATE INDEX IF NOT EXISTS ev_author ON events (pubkey, kind, d);
    CREATE INDEX IF NOT EXISTS ev_time ON events (created_at);
    CREATE INDEX IF NOT EXISTS ev_kind_time ON events (kind, created_at);
    CREATE INDEX IF NOT EXISTS ev_author_time ON events (pubkey, created_at);
    CREATE INDEX IF NOT EXISTS ev_author_kind_time ON events (pubkey, kind, created_at);
    CREATE TABLE IF NOT EXISTS tags (id TEXT, name TEXT, value TEXT, kind INTEGER, created_at INTEGER);
    CREATE INDEX IF NOT EXISTS tag_id ON tags (id);
    CREATE TRIGGER IF NOT EXISTS ev_tags_drop AFTER DELETE ON events BEGIN DELETE FROM tags WHERE id = old.id; END;`);   // kanban #1513: REQs read by index; #1543: tags too
  // kanban #1543: each event's single-letter tags (#p, #e, #d, ...) are kept in their own indexed table so a #<letter> filter is answered from the
  // index. kanban #1720 (#1489 v1 refute 48): a tag row carries its event's kind and created_at, so (name, value[, kind]) is read newest first and
  // stops at its LIMIT.
  // ONE ROW PER (event, name, value) (kanban #1915, #1959, #1998, #2010; #1489 v1 refute 48 s2): an event repeating ['p', R] 500 times wrote 500 rows,
  // so a stream reading `limit` rows found two events and hid every real zap receipt for R; and the check read an event's tags by id only, so a
  // candidate carrying 6000 tags cost 6000 row reads. Now tagRows writes each (name, value) of an event once, a UNIQUE index (id, name, value) keeps
  // it so, and the check is one seek in that index per value it asks for, whatever many tags the event carries.
  const PUT_TAG = 'INSERT OR IGNORE INTO tags (id, name, value, kind, created_at) VALUES (?, ?, ?, ?, ?)';
  let putTag = null;   // prepared once the table has all five columns (an older store gets them below)
  // each (name, value) of an event once (kanban #1915), only well-formed tags and at most MAX_TAG_ROWS of them (kanban #1704, #1753, #1960)
  const tagRows = (e) => { for (const [n, v] of indexedTags(e).slice(0, MAX_TAG_ROWS)) putTag.run(e.id, n, v, e.kind, e.created_at); };
  // THE TAGS TABLE IS BUILT IN ONE TRANSACTION AND MARKED DONE IN IT (kanban #1915, #1959, #1998, #2010): the build before added kind and
  // created_at with two autocommitted ALTERs and an UPDATE and judged "done" by the column being there, and backfilled an older store one
  // autocommitted row at a time and judged "done" by the table holding any row - a stop part way left tag rows with no time (never found again)
  // or events with no tag rows (never found again), and a stop between the ALTERs made every later start throw. Now a store below TAGS_VERSION gets,
  // inside one BEGIN IMMEDIATE ... COMMIT: each missing column added, every tag row rebuilt from the events themselves (one per (event, name,
  // value), with kind and created_at), the UNIQUE index, and PRAGMA user_version set. A stop anywhere rolls all of it back, and the next start
  // runs it again from the start.
  const TAGS_VERSION = 2;
  if ((db.prepare('PRAGMA user_version').get().user_version ?? 0) < TAGS_VERSION) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const cols = new Set(db.prepare('PRAGMA table_info(tags)').all().map((c) => c.name));
      if (!cols.has('kind')) db.exec('ALTER TABLE tags ADD COLUMN kind INTEGER');
      if (!cols.has('created_at')) db.exec('ALTER TABLE tags ADD COLUMN created_at INTEGER');
      db.exec('DELETE FROM tags; CREATE UNIQUE INDEX IF NOT EXISTS tag_key ON tags (id, name, value);');
      putTag = db.prepare(PUT_TAG);
      for (const r of db.prepare('SELECT json FROM events').iterate()) { let e; try { e = JSON.parse(r.json); } catch { continue; } if (Array.isArray(e?.tags)) tagRows(e); }
      db.exec(`PRAGMA user_version = ${TAGS_VERSION}`);
      db.exec('COMMIT');
    } catch (err) { try { db.exec('ROLLBACK'); } catch { /* none open */ } throw err; }
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS tag_key ON tags (id, name, value);
    CREATE INDEX IF NOT EXISTS tag_value_time ON tags (name, value, created_at);
    CREATE INDEX IF NOT EXISTS tag_value_kind_time ON tags (name, value, kind, created_at);`);
  putTag = db.prepare(PUT_TAG);
  // kanban #1704: a store written before has no `size`; it is added and filled once, each row's size as a new event's is counted
  if (!db.prepare('PRAGMA table_info(events)').all().some((c) => c.name === 'size')) db.exec('ALTER TABLE events ADD COLUMN size INTEGER');
  const unsized = db.prepare('SELECT id, json FROM events WHERE size IS NULL').all();
  if (unsized.length) {
    const setSize = db.prepare('UPDATE events SET size = ? WHERE id = ?');
    db.exec('BEGIN');
    // kanban #1960, #1994, #2009: a row that does not read is skipped, never fatal to the start
    for (const r of unsized) { let e; try { e = JSON.parse(r.json); } catch { continue; } setSize.run(eventSize(e, r.json, indexedTags(e).slice(0, MAX_TAG_ROWS)), r.id); }
    db.exec('COMMIT');
  }
  // kanban #1943, #1983: who holds what, per author and pool (see LOG_SHARE above) - temporary, so it is always rebuilt from the store itself
  db.exec(`CREATE TEMP TABLE IF NOT EXISTS holders (pubkey TEXT, pool INTEGER, n INTEGER, b INTEGER, first INTEGER, PRIMARY KEY (pubkey, pool));
    CREATE INDEX IF NOT EXISTS temp.holders_n ON holders (pool, n, first);
    CREATE INDEX IF NOT EXISTS temp.holders_b ON holders (pool, b, first);
    CREATE TEMP TABLE IF NOT EXISTS pools (pool INTEGER PRIMARY KEY, n INTEGER, b INTEGER);
    INSERT INTO holders (pubkey, pool, n, b, first) SELECT pubkey, ${POOL_SQL('kind')}, COUNT(*), COALESCE(SUM(size), 0), MIN(rowid) FROM main.events GROUP BY 1, 2;
    INSERT INTO pools (pool, n, b) SELECT pool, SUM(n), SUM(b) FROM holders GROUP BY pool;
    CREATE TEMP TRIGGER IF NOT EXISTS ev_hold_add AFTER INSERT ON main.events BEGIN
      INSERT INTO holders (pubkey, pool, n, b, first) VALUES (new.pubkey, ${POOL_SQL('new.kind')}, 1, COALESCE(new.size, 0), new.rowid)
        ON CONFLICT (pubkey, pool) DO UPDATE SET n = n + 1, b = b + excluded.b;
      INSERT INTO pools (pool, n, b) VALUES (${POOL_SQL('new.kind')}, 1, COALESCE(new.size, 0)) ON CONFLICT (pool) DO UPDATE SET n = n + 1, b = b + excluded.b;
    END;
    CREATE TEMP TRIGGER IF NOT EXISTS ev_hold_drop AFTER DELETE ON main.events BEGIN
      UPDATE holders SET n = n - 1, b = b - COALESCE(old.size, 0) WHERE pubkey = old.pubkey AND pool = ${POOL_SQL('old.kind')};
      DELETE FROM holders WHERE pubkey = old.pubkey AND pool = ${POOL_SQL('old.kind')} AND n <= 0;
      UPDATE pools SET n = n - 1, b = b - COALESCE(old.size, 0) WHERE pool = ${POOL_SQL('old.kind')};
    END;`);
  const totalUse = db.prepare('SELECT COALESCE(SUM(n), 0) AS n, COALESCE(SUM(b), 0) AS b FROM pools');
  const poolUse = db.prepare('SELECT n, b FROM pools WHERE pool = ?');
  const holderUse = db.prepare('SELECT n, b FROM holders WHERE pubkey = ? AND pool = ?');
  const largest = { n: db.prepare('SELECT pubkey, n, b FROM holders WHERE pool = ? AND pubkey != ? ORDER BY n DESC, first DESC LIMIT 1'),
    b: db.prepare('SELECT pubkey, n, b FROM holders WHERE pool = ? AND pubkey != ? ORDER BY b DESC, first DESC LIMIT 1') };
  const oldestIn = db.prepare(`SELECT id FROM events WHERE pubkey = ? AND ${POOL_SQL('kind')} = ? AND id != ? ORDER BY created_at ASC, id DESC LIMIT 1`);
  const put = db.prepare('INSERT OR IGNORE INTO events (id, pubkey, kind, created_at, d, json, size) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const newest = db.prepare('SELECT id, created_at FROM events WHERE pubkey = ? AND kind = ? AND d = ? ORDER BY created_at DESC, id ASC LIMIT 1');
  const drop = db.prepare('DELETE FROM events WHERE pubkey = ? AND kind = ? AND d = ? AND id != ?');
  const all = db.prepare('SELECT json FROM events ORDER BY created_at DESC');
  // kanban #1513: quotas (see AUTHOR_EVENTS above)
  const authorUse = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS b FROM events WHERE pubkey = ?');   // kanban #1704: bytes on disk
  // kanban #1621 (#1489 r4-nostr-2): the oldest by created_at alone was always a node's badge definitions (kind 30009, dated
  // BADGES_AT_S and published once), so ~500 rounds later its awards named definitions the relay no longer held. An author's
  // one-per-key events (replaceable: 0, 3, 10000-19999; parameterized replaceable but not a round's own 30762) now go only
  // after all its regular events and round results are gone; among each group the oldest still goes first.
  const authorOldest = db.prepare(`SELECT id FROM events WHERE pubkey = ? ORDER BY
    (kind = 0 OR kind = 3 OR (kind >= 10000 AND kind < 20000) OR (kind >= 30000 AND kind < 40000 AND kind != 30762)) ASC,
    created_at ASC, id DESC LIMIT 1`);
  const dropId = db.prepare('DELETE FROM events WHERE id = ?');
  const has = db.prepare('SELECT 1 AS x FROM events WHERE id = ?');
  const lim = { authorEvents: AUTHOR_EVENTS, authorBytes: AUTHOR_BYTES, totalEvents: TOTAL_EVENTS, totalBytes: TOTAL_BYTES, logShare: LOG_SHARE, totalSlowBytes: TOTAL_SLOW_BYTES, ...limits };
  const clients = new Set();
  const info = { name, description, supported_nips: [1, 11, 42, 46, 47, 57, 58, 65, 78], software: 'arena-node/nostr-relay', version: '1',
    limitation: { max_message_length: MAX_EVENT_BYTES, max_subscriptions: MAX_SUBS, max_filters: MAX_FILTERS, max_limit: MAX_LIMIT }, kinds };
  const server = createServer((req, res) => {
    // NIP-11: the information document; anything else is a short page
    res.writeHead(200, { 'content-type': /nostr\+json/.test(req.headers.accept || '') ? 'application/nostr+json' : 'text/plain; charset=utf-8',
      'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET' });
    res.end(/nostr\+json/.test(req.headers.accept || '') ? JSON.stringify(info) : `${name}: a Nostr relay (wss). ${description}\n`);
  });
  // kanban #1871: no automatic pong - the ws library queued one per ping outside every backlog check; the relay answers pings itself below
  const wss = new WebSocketServer({ server, maxPayload: MAX_EVENT_BYTES * 2, autoPong: false });
  // A FILTER IS ANSWERED BY SQL, NOT BY A SCAN (kanban #1543): stored() used to walk every row of the store and JSON.parse each one, once per filter,
  // until `limit` matched - a filter matching nothing (an unknown author) parsed the whole store, ten times a REQ, sixty REQs per 10 s per socket, and the
  // relay's one event loop (NIP-46 signing, NWC payments, logins) stalled for everyone.
  // NO FILTER SHAPE WALKS THE STORE (kanban #1720, #1489 v1 refute 48): one WHERE with ORDER BY created_at DESC LIMIT still read every row an index
  // could not hand over in time order - `kinds: [8], '#p': [unknown]` walked all kind-8 rows, `'#p': [common]` sorted every row with that tag (627 and
  // 1862 ms a REQ at 40000 events, up to seconds at the 200000 cap). Now a filter is answered in two bounded steps:
  //   1. candidates: the filter's most selective exact list picks streams - each id itself; else one per author (x kind); else one per value of its
  //      first #<letter> tag (x kind); else one per kind; else the whole store by time - and each stream is one index range read newest first
  //      (events (pubkey[, kind], created_at), tags (name, value[, kind], created_at), events (kind, created_at), events (created_at)) with since/until
  //      in the range and its own LIMIT; all streams together read at most SCAN_MOST index rows (each at least one), so no filter costs more;
  //   2. the candidates (by id, never a table walk) are checked against the WHOLE filter in SQL - ids, authors, kinds, since, until, every tag -
  //      newest first, `limit` of them; only those are parsed, and matches() still checks each one.
  // A filter whose matches are older than what its streams' share of SCAN_MOST reaches gets fewer events than it asked for (NIP-01 lets a relay
  // answer fewer); every query the game makes (one author or a few nodes, a kind or two, one #p or #d) is read in full. An id or author prefix
  // never matched (matches() compares whole values), and still does not: a prefix entry is dropped, and a list left empty matches nothing.
  const SCAN_MOST = 2000, MAX_STREAMS = 100;
  const stmts = new Map();
  const stmt = (sql) => { let s = stmts.get(sql); if (!s) { s = db.prepare(sql); stmts.set(sql, s); } return s; };   // a few dozen shapes at most
  const TIME = 'created_at >= ? AND created_at <= ? ORDER BY created_at DESC LIMIT ?';
  const STREAM = {
    time: `SELECT id, created_at FROM events INDEXED BY ev_time WHERE ${TIME}`,
    kind: `SELECT id, created_at FROM events INDEXED BY ev_kind_time WHERE kind = ? AND ${TIME}`,
    author: `SELECT id, created_at FROM events INDEXED BY ev_author_time WHERE pubkey = ? AND ${TIME}`,
    authorKind: `SELECT id, created_at FROM events INDEXED BY ev_author_kind_time WHERE pubkey = ? AND kind = ? AND ${TIME}`,
    tag: `SELECT id, created_at FROM tags INDEXED BY tag_value_time WHERE name = ? AND value = ? AND ${TIME}`,
    tagKind: `SELECT id, created_at FROM tags INDEXED BY tag_value_kind_time WHERE name = ? AND value = ? AND kind = ? AND ${TIME}`,
  };   // INDEXED BY: the planner must not pick an index it then sorts by (tag_value_kind_time for a tag without kinds read every row of a common tag)
  const planFor = (f) => {
    const lim = Math.min(Number.isInteger(f.limit) ? f.limit : MAX_LIMIT, MAX_LIMIT);
    if (!lim) return null;
    const full = (v) => [...new Set(v.filter((x) => x.length === 64))];
    const ids = f.ids && full(f.ids), authors = f.authors && full(f.authors), kinds = f.kinds && [...new Set(f.kinds)];
    const tags = Object.entries(f).filter(([k]) => k[0] === '#' && k.length === 2).map(([k, v]) => [k[1], [...new Set(v)]]);
    if ((ids && !ids.length) || (authors && !authors.length) || (kinds && !kinds.length) || tags.some(([, v]) => !v.length)) return null;
    const since = f.since ?? 0, until = f.until ?? Number.MAX_SAFE_INTEGER;
    if (since > until) return null;
    let streams, covered = false;   // [sql, ...keys]; covered: the streams' keys are the whole filter (each stream needs only `limit` rows)
    const kinded = (n) => !kinds || n * kinds.length <= MAX_STREAMS;
    const byKind = (keys, sql, sqlK) => (kinds && kinded(keys.length)
      ? keys.flatMap((k) => kinds.map((kd) => [sqlK, ...[k].flat(), kd])) : keys.map((k) => [sql, ...[k].flat()]));
    if (ids) streams = null;
    else if (authors) { streams = byKind(authors, STREAM.author, STREAM.authorKind); covered = !tags.length && kinded(authors.length); }
    else if (tags.length) { streams = byKind(tags[0][1].map((v) => [tags[0][0], v]), STREAM.tag, STREAM.tagKind); covered = tags.length === 1 && kinded(tags[0][1].length); }
    else if (kinds) { streams = kinds.map((k) => [STREAM.kind, k]); covered = true; }
    else { streams = [[STREAM.time]]; covered = true; }
    const where = [], args = [];
    if (ids) { where.push('e.id IN (SELECT value FROM json_each(?))'); args.push(JSON.stringify(ids)); }
    if (authors) { where.push('e.pubkey IN (SELECT value FROM json_each(?))'); args.push(JSON.stringify(authors)); }
    if (kinds) { where.push('e.kind IN (SELECT value FROM json_each(?))'); args.push(JSON.stringify(kinds)); }
    where.push('e.created_at >= ? AND e.created_at <= ?'); args.push(since, until);
    for (const [name, vals] of tags) {
      where.push('EXISTS (SELECT 1 FROM tags t INDEXED BY tag_key WHERE t.id = e.id AND t.name = ? AND t.value IN (SELECT value FROM json_each(?)))'); args.push(name, JSON.stringify(vals));
    }
    // the check reads only the indexed columns (and tags by id); the json of just the `limit` survivors is read after
    const check = `SELECT e.id FROM json_each(?) c CROSS JOIN events e ON e.id = c.value WHERE ${where.join(' AND ')} ORDER BY e.created_at DESC, e.id LIMIT ?`;
    return { ids, streams, covered, since, until, lim, check, args };
  };
  const candidates = (p) => {
    if (p.ids) return p.ids;
    let per = Math.max(1, Math.floor(SCAN_MOST / p.streams.length));
    if (p.covered) per = Math.min(per, p.lim);   // kanban #1915 etc.: one row per (event, name, value), so `limit` rows are `limit` events
    const seen = new Set();
    for (const [sql, ...keys] of p.streams) for (const r of stmt(sql).all(...keys, p.since, p.until, per)) seen.add(r.id);
    return [...seen];
  };
  const JSON_OF = 'SELECT e.json FROM json_each(?) c CROSS JOIN events e ON e.id = c.value';
  const stored = (filters) => {
    const out = new Map();
    for (const f of filters) {
      const p = planFor(f);
      if (!p) continue;
      const c = candidates(p);
      if (!c.length) continue;
      const keep = stmt(p.check).all(JSON.stringify(c), ...p.args, p.lim).map((r) => r.id);
      if (!keep.length) continue;
      for (const row of stmt(JSON_OF).all(JSON.stringify(keep))) {
        const e = JSON.parse(row.json);
        if (matches(f, e) && !out.has(e.id)) out.set(e.id, e);
      }
    }
    return [...out.values()].sort((a, b) => b.created_at - a.created_at);
  };
  // kanban #1720: the query plans a filter runs (for the test that holds every shape to an index read)
  const plans = (f) => {
    const p = planFor(f);
    if (!p) return [];
    const sqls = [...new Set((p.streams || []).map(([sql]) => sql)), p.check, JSON_OF];
    return sqls.map((sql) => ({ sql, plan: db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...Array((sql.match(/\?/g) || []).length).fill(null)).map((r) => r.detail) }));
  };
  // A SUBSCRIBER THAT DOES NOT READ IS DROPPED (kanban #1542): every matching subscription of every client gets its own copy of each
  // event, and ws.send queues it in this process when the peer stops reading - ephemeral events too, which are never stored. A
  // client whose unsent backlog has passed SLOW_BYTES is told so and cut off, so one stalled socket holds at most a few MB here.
  // EVERY OUTGOING MESSAGE IS BOUNDED (kanban #1717, a bypass of #1542): the REQ answer and the small replies (OK, NOTICE, CLOSED)
  // went through a send() that never looked at bufferedAmount, so a socket that stopped reading and sent REQs for stored events
  // had every stored match queued again for each REQ (measured 132.8 MB for one socket). Now each message goes through dropSlow:
  // the EVENT fan-out drops a client past SLOW_BYTES as before; a REQ answer stops at SLOW_BYTES with CLOSED (a reading client may
  // ask again with a smaller limit or `until`); anything else past HARD_SLOW_BYTES drops the client. One socket holds at most ~8 MB.
  const dropSlow = (o) => {
    clients.delete(o);
    try { o.ws.send(JSON.stringify(['NOTICE', 'error: too slow, the relay stopped sending'])); } catch { /* gone */ }
    o.ws.terminate();
  };
  // ALL CLIENTS TOGETHER ARE BOUNDED (kanban #1871, #1904): `queued` is an upper estimate of the unsent bytes of all clients - each
  // message queued adds its length, a 1 s timer (and every time the estimate passes the bound) sets it to the real sum of bufferedAmount.
  // Past lim.totalSlowBytes the clients with the largest backlogs are dropped until the sum is under it again.
  const backlog = () => { let n = 0; for (const o of clients) n += o.ws.bufferedAmount; return n; };
  let queued = 0;
  const recount = setInterval(() => { queued = backlog(); }, 1000);
  recount.unref?.();
  const shed = () => {
    queued = backlog();
    while (queued > lim.totalSlowBytes) {
      let big = null;
      for (const o of clients) if (!big || o.ws.bufferedAmount > big.ws.bufferedAmount) big = o;
      if (!big || !big.ws.bufferedAmount) break;
      queued -= big.ws.bufferedAmount;
      clients.delete(big);
      // a reset, not a close: what the kernel still holds for that socket (it never read it) is thrown away too, not sent after
      try { big.ws._socket?.resetAndDestroy?.(); } catch { /* gone */ }
      big.ws.terminate();
    }
  };
  const queue = (o, msg) => {   // every message the relay sends goes through here
    o.ws.send(msg);
    queued += msg.length;
    if (queued > lim.totalSlowBytes) shed();
  };
  const fanOut = (o, sid, e) => {
    if (o.ws.readyState !== 1) return;
    if (o.ws.bufferedAmount > SLOW_BYTES) return dropSlow(o);
    queue(o, JSON.stringify(['EVENT', sid, e]));
  };
  wss.on('connection', (ws) => {
    const subs = new Map();
    const c = { ws, subs };
    clients.add(c);
    let budget = 60, pings = PINGS, refill = setInterval(() => { budget = Math.min(60, budget + 20); pings = PINGS; }, 10000);
    const send = (m) => {   // kanban #1717: no message is queued for a client already HARD_SLOW_BYTES behind
      if (ws.readyState !== 1) return;
      if (ws.bufferedAmount > HARD_SLOW_BYTES) return dropSlow(c);
      queue(c, JSON.stringify(m));
    };
    // kanban #1871: a ping is answered like any other message - not past HARD_SLOW_BYTES (the client is dropped), and at most PINGS per
    // 10 s (more get no pong); the pong counts toward the relay-wide backlog
    ws.on('ping', (d) => {
      if (ws.readyState !== 1 || --pings < 0) return;
      if (ws.bufferedAmount > HARD_SLOW_BYTES) return dropSlow(c);
      ws.pong(d);
      queued += d.length + 2;
      if (queued > lim.totalSlowBytes) shed();
    });
    ws.on('close', () => { clients.delete(c); clearInterval(refill); });
    // kanban #1470, #1726, #1796, #1833: a frame ws itself refuses (over maxPayload, a text frame that is not UTF-8, a reserved bit set, a bad
    // opcode) never reaches 'message' - ws emits 'error' on this socket and closes it. Without a listener the EventEmitter throws and the relay
    // process ends for every player; with one, only this socket goes.
    ws.on('error', () => { clients.delete(c); clearInterval(refill); try { ws.terminate(); } catch { /* already gone */ } });
    ws.on('message', (raw) => { try { onMessage(raw); } catch (err) { try { send(['NOTICE', 'error: that message could not be handled']); } catch { /* the socket is gone */ } } });   // kanban #1470: no message takes the relay down
    const onMessage = (raw) => {
      if (raw.length > MAX_EVENT_BYTES * 2) return send(['NOTICE', 'message too large']);
      if (--budget < 0) return send(['NOTICE', 'rate-limited: slow down']);
      let m; try { m = JSON.parse(String(raw)); } catch { return send(['NOTICE', 'invalid: not JSON']); }
      if (!Array.isArray(m)) return send(['NOTICE', 'invalid: not a message']);
      if (m[0] === 'EVENT') {
        const e = m[1];
        if (JSON.stringify(e || null).length > MAX_EVENT_BYTES) return send(['OK', e && e.id, false, 'invalid: event too large']);
        const why = eventRefusal(e, { kinds });
        if (why) return send(['OK', e && e.id, false, why]);
        if (!isEphemeral(e.kind)) {
          const d = isParam(e.kind) ? dTag(e) : '';
          if (isReplaceable(e.kind) || isParam(e.kind)) {
            const cur = newest.get(e.pubkey, e.kind, d);
            if (cur && (cur.created_at > e.created_at || (cur.created_at === e.created_at && cur.id < e.id)))
              return send(['OK', e.id, true, 'duplicate: a newer one is kept']);
          }
          const json = JSON.stringify(e);
          if (!has.get(e.id)) {   // a copy already kept changes nothing (as INSERT OR IGNORE did)
            const rows = indexedTags(e);
            if (rows.length > MAX_TAG_ROWS) return send(['OK', e.id, false, `blocked: more than ${MAX_TAG_ROWS} single-letter tags`]);   // kanban #1704
            // kanban #1513: the author's own quota (their oldest goes), then the relay's total. kanban #1769: the total is checked on the NET change,
            // after the replaceable drop and the author's own trim, so a replacement (a newer kind 0 profile, a node's settled 30762 under the same d)
            // or an author rolling its own oldest out adds nothing and is kept on a full relay; only an event that grows the store past the total is
            // refused. kanban #1811: all of it is one transaction (one write, not one per tag row), rolled back when it is refused.
            const before = { ...totalUse.get() };
            let verdict = 'kept';
            db.exec('BEGIN');
            try {
              if (put.run(e.id, e.pubkey, e.kind, e.created_at, d, json, eventSize(e, json, rows)).changes) tagRows(e);   // kanban #1543: its tags indexed with it
              if (isReplaceable(e.kind) || isParam(e.kind)) drop.run(e.pubkey, e.kind, d, e.id);
              let use = authorUse.get(e.pubkey);
              while (use.n > 1 && (use.n > lim.authorEvents || use.b > lim.authorBytes)) {
                const old = authorOldest.get(e.pubkey);
                if (!old) break;
                dropId.run(old.id);
                use = authorUse.get(e.pubkey);
              }
              if (!has.get(e.id)) verdict = 'older';
              else {
                // kanban #1769: only growth past the total counts (a store already past a lowered limit keeps what does not grow it);
                // kanban #1943, #1983: room is made by fair share (LOG_SHARE above), refused only when nobody holds more than this author
                const capN = Math.max(lim.totalEvents, before.n), capB = Math.max(lim.totalBytes, before.b);
                const P = poolOf(e.kind), Q = 1 - P;
                for (;;) {
                  const t = totalUse.get();
                  const dim = t.n > capN ? 'n' : t.b > capB ? 'b' : null;
                  if (!dim) break;
                  const share = (pool) => (dim === 'n' ? lim.totalEvents : lim.totalBytes) * (pool === 1 ? lim.logShare : 1 - lim.logShare);
                  let victim = null;
                  const q = poolUse.get(Q);
                  if (q && q[dim] > share(Q)) { const h = largest[dim].get(Q, ''); if (h) victim = oldestIn.get(h.pubkey, Q, e.id); }   // 1.
                  if (!victim) {   // 2.
                    const mine = holderUse.get(e.pubkey, P) || { n: 0, b: 0 }, h = largest[dim].get(P, e.pubkey);
                    if (h && h[dim] > mine[dim]) victim = oldestIn.get(h.pubkey, P, e.id);
                  }
                  if (!victim && P === 0) victim = oldestIn.get(e.pubkey, 0, e.id);   // 3.
                  if (!victim) { verdict = 'full'; break; }   // 4.
                  dropId.run(victim.id);
                }
              }
              if (verdict === 'kept') db.exec('COMMIT'); else db.exec('ROLLBACK');
            } catch (err) {
              // kanban #1960, #1994, #2009: a throw in the store step rolls all of it back and is answered - never thrown out of the socket's handler
              try { db.exec('ROLLBACK'); } catch { /* none open */ }
              return send(['OK', e.id, false, 'error: the event could not be stored']);
            }
            if (verdict === 'full') return send(['OK', e.id, false, 'blocked: the relay is full']);
            if (verdict === 'older') return send(['OK', e.id, false, 'blocked: older than all this author already has, over the quota']);
          }
        }
        send(['OK', e.id, true, '']);
        const tagSets = eventTagSets(e);   // kanban #1752: once per event; each filter was compiled at its REQ
        for (const o of clients) for (const [sid, fs] of o.subs) if (fs.some((c) => matchesCompiled(c, e, tagSets))) fanOut(o, sid, e);
        return undefined;
      }
      if (m[0] === 'REQ') {
        const sid = String(m[1] || '');
        const filters = m.slice(2).filter((f) => f && typeof f === 'object');
        if (!sid || sid.length > 64) return send(['CLOSED', sid, 'invalid: subscription id']);
        if (!filters.length || filters.length > MAX_FILTERS) return send(['CLOSED', sid, `invalid: 1 to ${MAX_FILTERS} filters`]);
        { const bad = filters.map(filterRefusal).find(Boolean); if (bad) return send(['CLOSED', sid, `invalid: ${bad}`]); }   // kanban #1470
        if (!subs.has(sid) && subs.size >= MAX_SUBS) return send(['CLOSED', sid, `blocked: at most ${MAX_SUBS} subscriptions`]);
        subs.set(sid, filters.map(compileFilter));   // kanban #1752: Sets, built once
        for (const e of stored(filters)) {
          if (ws.readyState !== 1) return undefined;
          // kanban #1717: the stored answer stops once this socket's unsent backlog passes SLOW_BYTES; the subscription ends
          if (ws.bufferedAmount > SLOW_BYTES) { subs.delete(sid); return send(['CLOSED', sid, 'error: too slow, the answer was cut; ask again with a smaller limit']); }
          queue(c, JSON.stringify(['EVENT', sid, e]));   // kanban #1904: counted toward the relay-wide backlog (may drop this client)
        }
        return send(['EOSE', sid]);
      }
      if (m[0] === 'CLOSE') { subs.delete(String(m[1] || '')); return undefined; }
      return send(['NOTICE', `unknown message ${String(m[0]).slice(0, 20)}`]);
    };
  });
  await new Promise((r) => server.listen(port, host, r));
  return {
    port: server.address().port,
    events: () => all.all().map((r) => JSON.parse(r.json)),
    plans,
    close: () => new Promise((r) => { clearInterval(recount); for (const c of clients) c.ws.terminate(); wss.close(); server.close(() => { db.close(); r(); }); }),
  };
}
