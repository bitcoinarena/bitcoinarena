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
//     and is refused ('blocked: the relay is full') only when no one holds more than its author; an author in `keep` (the seats' node
//     keys, ARENA_RELAY_KEEP) never gives back for another author's write (kanban #2146, #2214);
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
const LIST_MOST = 500, TAG_KEYS_MOST = 8;   // kanban #2553: tag keys per filter
export function filterRefusal(f) {
  if (!f || typeof f !== 'object' || Array.isArray(f)) return 'a filter is an object';
  const hexList = (v) => Array.isArray(v) && v.length <= LIST_MOST && v.every((x) => typeof x === 'string' && /^[0-9a-f]{1,64}$/.test(x));
  if (f.ids !== undefined && !hexList(f.ids)) return 'ids is a list of hex';
  if (f.authors !== undefined && !hexList(f.authors)) return 'authors is a list of hex';
  if (f.kinds !== undefined && !(Array.isArray(f.kinds) && f.kinds.length <= LIST_MOST && f.kinds.every((k) => Number.isInteger(k) && k >= 0 && k <= 65535))) return 'kinds is a list of whole numbers';
  for (const k of ['since', 'until', 'limit']) if (f[k] !== undefined && !(Number.isInteger(f[k]) && f[k] >= 0)) return `${k} is a whole number`;
  // A FILTER NAMES FEW TAG LETTERS (kanban #2553, #1489 r13-nostr-1): any one UTF-16 unit passed as a letter, so one filter could name
  // thousands of distinct keys ("#一", "#丁", ...) and sqlFor ran a prepare + COUNT for each, then one EXISTS per key - ten such filters
  // per REQ held the event loop ~270 ms. A tag key is #<a-zA-Z> (NIP-01's letters) and a filter names at most TAG_KEYS_MOST of them.
  let tagKeys = 0;
  for (const [k, v] of Object.entries(f)) {
    if (k[0] !== '#') continue;
    if (!/^#[a-zA-Z]$/.test(k)) return `${k.slice(0, 8)} is not #<letter a-z or A-Z>`;
    if (++tagKeys > TAG_KEYS_MOST) return `at most ${TAG_KEYS_MOST} #<letter> conditions per filter`;
    if (!(Array.isArray(v) && v.length <= LIST_MOST && v.every((x) => typeof x === 'string'))) return `${k.slice(0, 8)} is a list of strings`;
  }
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
  limits = {}, keep = [], description = 'The game\'s own relay: profiles, relay lists, encrypted game seeds (NIP-78), remote signing (NIP-46), wallet connect (NIP-47), the nodes\' signed round results (kind 30762) and their badges (NIP-58: kinds 30009 and 8), and zap receipts (NIP-57: kind 9735). Nothing else is kept.' } = {}) {
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
  // A TAG ROW WRITTEN WITHOUT ITS EVENT'S TIME OR KIND (kanban #2246, #2378; #1489 a45-refute-11) gets them from its event on every start, through
  // tag_unfilled / tag_nokind, so the walk newest first from tags (name, value[, kind], created_at) finds it
  db.exec(`CREATE INDEX IF NOT EXISTS tag_unfilled ON tags (id) WHERE created_at IS NULL;
    UPDATE tags INDEXED BY tag_unfilled SET created_at = COALESCE((SELECT created_at FROM events WHERE events.id = tags.id), 0) WHERE created_at IS NULL;
    CREATE INDEX IF NOT EXISTS tag_nokind ON tags (id) WHERE kind IS NULL;
    UPDATE tags INDEXED BY tag_nokind SET kind = COALESCE((SELECT kind FROM events WHERE events.id = tags.id), -1) WHERE kind IS NULL;`);
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
  const largest = { n: db.prepare('SELECT pubkey, n, b FROM holders WHERE pool = ? AND pubkey != ? AND pubkey NOT IN (SELECT value FROM json_each(?)) ORDER BY n DESC, first DESC LIMIT 1'),
    b: db.prepare('SELECT pubkey, n, b FROM holders WHERE pool = ? AND pubkey != ? AND pubkey NOT IN (SELECT value FROM json_each(?)) ORDER BY b DESC, first DESC LIMIT 1') };
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
  // MAKING ROOM IS NOT A WAY TO DELETE A NODE'S RESULTS (kanban #2146, #2214; #1489 a44-refute-24): keys are free - strangers who fill the
  // total with one event a key leave the NODE the largest holder, and then every stranger 30078 under a fresh key and `d` took one of the
  // node's kept, signed round results. An author in `keep` (the seats' node keys: ARENA_RELAY_KEEP for tools/nostr-relay.mjs) is never the
  // largest holder that gives back for another author's write; it still rolls out its own oldest (step 3, its quota).
  const keepList = (Array.isArray(keep) ? keep : [...(keep || [])]).map((k) => String(k).toLowerCase()).filter((k) => HEX64.test(k));
  const keepJson = JSON.stringify(keepList), keepSet = new Set(keepList);
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
  // relay's one event loop (NIP-46 signing, NWC payments, logins) stalled for everyone. Now ids, authors, kinds, since, until and #<letter> tags are a
  // WHERE on indexed columns with LIMIT, so a filter parses at most `limit` rows (MAX_LIMIT), all of which match; matches() still checks each one.
  // A FILTER'S WORK IS BOUNDED, NOT ONLY ITS ROWS (kanban #1826, #1489 r6-nostr-1): with #1543 a filter pairing a common condition with one
  // nothing meets ({"#a":["x"],"#p":["nobody"]}, {kinds:[8],"#p":["nobody"]}) still let SQLite walk every row of the store in created_at order,
  // checking the other condition on each - one REQ of ten such filters held the event loop for seconds. Now each condition (ids, authors,
  // kinds, each #<letter>) is counted from its own index, at most DRIVE_ROWS+1 rows, and the smallest set drives the query (joined to events by
  // primary key, every other condition checked on that row); when every condition is bigger than DRIVE_ROWS, a filter of one condition reads its
  // index as before (every row it reads matches), and a filter of several examines only the newest SCAN_ROWS events.
  // NO WINDOW OF THE NEWEST, AND EVERY INDEX READ COUNTED (kanban #2246, #2258, #2275; #1489 a45-refute-11): the one-condition path's WHERE
  // was the correlated EXISTS, so {"#a":["old"]} on 3000 old rows under 150,000 newer ones walked the whole store; a drive count of DISTINCT
  // ids read every duplicate tag row; and the several-condition path looked only at the newest SCAN_ROWS events, so a recipient's zap read
  // ({kinds:[9735],"#p":[R]}) answered nothing once 20,000 newer events existed. Now a count reads at most DRIVE_ROWS+1 index rows (not
  // distinct ids); when nothing drives, one condition is WALKED newest first from its own created_at-ordered index (a tag value from
  // tag_value_time, a kind from ev_kind_time, an author from ev_author_time, else the store from ev_time), the time window inside the walk,
  // every other condition checked on each row it reads, at most SCAN_ROWS rows for one REQ (all its filters together). Every match of a filter is found unless that budget
  // ran out first - then the client is told (NOTICE 'error: filter too broad ...') rather than given a silent EOSE.
  // EACH CANDIDATE'S CHECK IS BOUNDED TOO, AND A {kinds, #tag} READ IS ITS OWN INDEX (kanban #2378, #2380; #1489 a45-refute-11-s2 on #1826):
  // SCAN_ROWS bounded how many candidates a walk reads, but each was checked by a correlated EXISTS (... value IN (500 values)) - one index
  // seek per listed value - so ten {"#a":["x"],"#p":[500 values]} held the event loop 1.8 s and one filter of 25 such conditions 59 s.
  // Now: the condition that drives or is walked is never checked again (its index rows meet it); every other condition costs its seeks
  // (a tag: its values; ids/authors: their prefixes, + 1 for the full ones; kinds: 1) per candidate, charged to one REQ's WORK_ROWS -
  // a drive whose rows x cost is over it is walked newest first instead (or, without a stream, reads only what the work allows), and a
  // walk stops there with the NOTICE. Counting a condition to choose the drive is charged (rows + seeks) to its own DRIVE budget.
  // And a stranger flooding both indexes of {kinds:[9735],"#p":[R]} with newer non-matches (9735 to others, kind 8 to R) buried R's
  // receipts whichever was walked: each tag row now carries its event's kind, and a tag condition beside kinds (values x kinds at most
  // LIST_MOST) is also counted, driven and walked from tags (name, value, kind, created_at) - exactly R's own kind-9735 rows, newest first.
  const DRIVE_ROWS = 2000, SCAN_ROWS = 20000, CHECK_BATCH = 250, WORK_ROWS = 4 * SCAN_ROWS, WALK_COUNT_ROWS = 2 * DRIVE_ROWS;
  const plan = (f, budget) => {
    const conds = [], pairs = [], time = [], timeArgs = [];
    const timeOn = (col) => ({ sql: [f.since !== undefined ? `${col} >= ?` : null, f.until !== undefined ? `${col} <= ?` : null].filter(Boolean), args: [f.since, f.until].filter((x) => x !== undefined) });
    const hexIn = (col, list) => {   // full 64-hex values by equality, NIP-01 prefixes as an index range [prefix, prefix + 'g')
      const full = list.filter((x) => x.length === 64), pre = list.filter((x) => x.length < 64), or = [], args = [];
      if (full.length) { or.push(`${col} IN (${full.map(() => '?').join(',')})`); args.push(...full); }
      for (const x of pre) { or.push(`(${col} >= ? AND ${col} < ?)`); args.push(x, `${x}g`); }
      return { where: `(${or.join(' OR ')})`, args, cost: pre.length + (full.length ? 1 : 0) };
    };
    for (const k of ['ids', 'authors', 'kinds']) if (Array.isArray(f[k]) && !f[k].length) return null;   // an empty list matches nothing
    const tE = timeOn('e.created_at'), tC = timeOn('created_at');
    const and = (ws) => (ws.length ? ` AND ${ws.join(' AND ')}` : '');
    const qs = (l) => l.map(() => '?').join(',');
    // a stream: (id, created_at, rowid) rows of one index, newest first, the time window applied inside the index, read in keyset pages.
    // kanban #2418, #2419 (#1489 a45-refute-11-s3 on #1826): the keyset was 'created_at <= t AND (created_at < t OR rowid < rid)', which is
    // no index range - each page re-read, and threw away, every row of created_at t it had already returned, so 20,000 events of ONE
    // created_at walked in pages of 10 were ~20 million index rows (the budget counted 20,000) and one REQ held the event loop ~1.1 s.
    // Now a page is two index ranges, each read row returned: the rest of the current second (created_at = t AND rowid < rid - rowid is
    // the trailing key column of every index walked here) and then the older seconds (created_at < t). Same order, same rows.
    const stream = (from, eq, args) => {
      const head = `SELECT id, created_at AS t, rowid AS rid FROM ${from} WHERE ${eq}${and(tC.sql)} AND created_at`;
      return { grp: `${head} = ? AND rowid < ? ORDER BY rowid DESC LIMIT ?`, older: `${head} < ? ORDER BY created_at DESC, rowid DESC LIMIT ?`, args: [...args, ...tC.args] };
    };
    const onEvents = (c, timed) => ({ ...c, drive: `SELECT e.id AS id FROM events e WHERE ${c.where}${timed ? and(tE.sql) : ''}`, driveArgs: [...c.args, ...(timed ? tE.args : [])] });
    if (f.ids) conds.push({ ...onEvents(hexIn('e.id', f.ids), false), streams: null, seeks: f.ids.length });
    if (f.authors) conds.push({ ...onEvents(hexIn('e.pubkey', f.authors), true), seeks: f.authors.length,
      streams: f.authors.every((a) => a.length === 64) ? [...new Set(f.authors)].map((a) => stream('events INDEXED BY ev_author_time', 'pubkey = ?', [a])) : null });
    const kinds = f.kinds ? [...new Set(f.kinds)] : null;
    let kindsCond = null;
    if (kinds) conds.push((kindsCond = { ...onEvents({ where: `e.kind IN (${qs(f.kinds)})`, args: [...f.kinds], cost: 1 }, true), seeks: kinds.length,
      streams: kinds.map((k) => stream('events INDEXED BY ev_kind_time', 'kind = ?', [k])) }));
    if (f.since !== undefined) { time.push('e.created_at >= ?'); timeArgs.push(f.since); }
    if (f.until !== undefined) { time.push('e.created_at <= ?'); timeArgs.push(f.until); }
    for (const [k, vals] of Object.entries(f)) {
      if (k[0] !== '#' || k.length !== 2) continue;
      if (!vals.length) return null;
      const uv = [...new Set(vals)];
      const inV = `value IN (${qs(uv)})`, args = [k[1], ...uv];
      const tc = { where: `EXISTS (SELECT 1 FROM tags t INDEXED BY tag_key WHERE t.id = e.id AND t.name = ? AND t.${inV})`, args, cost: uv.length, seeks: uv.length,
        count: `SELECT id FROM tags INDEXED BY tag_value_time WHERE name = ? AND ${inV}${and(tC.sql)}`,
        drive: `SELECT DISTINCT id FROM tags INDEXED BY tag_value_time WHERE name = ? AND ${inV}${and(tC.sql)}`, driveArgs: [...args, ...tC.args],
        streams: uv.map((v) => stream('tags INDEXED BY tag_value_time', 'name = ? AND value = ?', [k[1], v])) };
      conds.push(tc);
      if (kinds && uv.length * kinds.length <= LIST_MOST) {   // this tag and the kinds together, from tags (name, value, kind, created_at)
        const inVK = `name = ? AND ${inV} AND kind IN (${qs(kinds)})${and(tC.sql)}`;
        pairs.push({ covers: [tc, kindsCond], seeks: uv.length * kinds.length,
          count: `SELECT id FROM tags INDEXED BY tag_value_kind_time WHERE ${inVK}`, drive: `SELECT DISTINCT id FROM tags INDEXED BY tag_value_kind_time WHERE ${inVK}`,
          driveArgs: [...args, ...kinds, ...tC.args],
          streams: uv.flatMap((v) => kinds.map((kk) => stream('tags INDEXED BY tag_value_kind_time', 'name = ? AND value = ? AND kind = ?', [k[1], v, kk]))) });
      }
    }
    const limit = Math.min(Number.isInteger(f.limit) ? f.limit : MAX_LIMIT, MAX_LIMIT);
    // what is checked on each candidate of a driver: every condition it does not itself meet, and the time window; cost = their seeks
    const checkFor = (d) => {
      const skip = new Set(d ? (d.covers || [d]) : []), cs = conds.filter((c) => !skip.has(c));
      return { sql: [...cs.map((c) => c.where), ...time], args: [...cs.flatMap((c) => c.args), ...timeArgs], cost: cs.reduce((a, c) => a + c.cost, 0) };
    };
    const drivers = [...pairs, ...conds];
    let best = null;
    for (const c of drivers) {   // kanban #2258: index ROWS read, at most DRIVE_ROWS+1 - a thousand copies of one tag are a thousand rows
      if (budget.drive <= 0) break;   // kanban #2378: counting is charged too (rows + seeks)
      const n = db.prepare(`SELECT COUNT(*) AS n FROM (${c.count || c.drive} LIMIT ${DRIVE_ROWS + 1})`).get(...c.driveArgs).n;
      budget.drive -= n + c.seeks;
      if (n <= DRIVE_ROWS && (!best || n < best.n)) best = { c, n };
    }
    if (best) {   // the smallest set drives: at most DRIVE_ROWS rows are read and sorted, and their checks fit the REQ's work
      const chk = checkFor(best.c), can = chk.cost ? Math.floor(Math.max(0, budget.work) / chk.cost) : Infinity;
      const sql = (drive) => `SELECT e.json AS json FROM (${drive}) d CROSS JOIN events e ON e.id = d.id WHERE ${['1', ...chk.sql].join(' AND ')} ORDER BY e.created_at DESC LIMIT ?`;
      if (best.n <= can) { budget.work -= best.n * chk.cost; return { limit, sql: sql(best.c.drive), args: [...best.c.driveArgs, ...chk.args, limit] }; }
      if (best.c.streams) return { limit, streams: best.c.streams, check: chk };   // walked newest first, its checks charged one by one
      budget.work -= can * chk.cost;
      return { limit, broad: true, sql: sql(`${best.c.drive} LIMIT ${can}`), args: [...best.c.driveArgs, ...chk.args, limit] };
    }
    // kanban #2246, #2275: nothing is small - walk the smallest condition newest first (each counted from its index, at most SCAN_ROWS+1
    // rows, never more than the smallest so far), at most SCAN_ROWS index rows: a condition of SCAN_ROWS rows or fewer is walked to its end.
    // These counts too come out of the REQ's budget (budget.count): many big conditions are not counted once it is spent.
    // kanban #2380: a tag-and-kinds pair is counted first, so a recipient's own kind is walked when it is the smaller.
    let walk = null;
    for (const c of drivers) {
      if (!c.streams) continue;
      // counted at most WALK_COUNT_ROWS+1 rows each (kanban #1720 with #2246): what is walked is still bounded by SCAN_ROWS, but choosing it no
      // longer reads up to SCAN_ROWS index rows per condition, so a REQ's cost does not grow with the store (a tie goes to the first: pairs lead)
      const cap = Math.min(WALK_COUNT_ROWS, walk ? walk.n : WALK_COUNT_ROWS, budget.count);
      if (cap <= 0) { if (!walk) walk = { c, n: Infinity }; continue; }
      const n = db.prepare(`SELECT COUNT(*) AS n FROM (${c.count || c.drive} LIMIT ${cap + 1})`).get(...c.driveArgs).n;
      budget.count -= n + c.seeks;
      if (!walk || n < walk.n) walk = { c, n };
    }
    const streams = walk ? walk.c.streams : [stream('events INDEXED BY ev_time', '1', [])];
    return { limit, streams, check: checkFor(walk && walk.c) };
  };
  // the rows of a walk: candidates newest first (several streams merged by created_at, each read in keyset pages), each batch checked
  // against every other condition in SQL; at most SCAN_ROWS candidates for the whole REQ (budget.left), each one's check charged to
  // budget.work (kanban #2378), and at most a quarter more rows read ahead
  const walkRows = (q, budget) => {
    const out = [], seen = new Set(), heap = [], stmts = new Map(), cost = q.check.cost;
    const spent = () => budget.left <= 0 || (cost > 0 && budget.work < cost);
    if (spent()) return { rows: out, broad: true };
    const where = q.check.sql.length ? ` AND ${q.check.sql.join(' AND ')}` : '';
    // CROSS JOIN: each candidate is looked up by primary key (a bare IN beside kind IN (...) let SQLite walk ev_kind_time instead)
    const check = db.prepare(`SELECT e.json AS json FROM (SELECT value AS id FROM json_each(?)) d CROSS JOIN events e ON e.id = d.id WHERE 1${where} ORDER BY e.created_at DESC`);
    const checkBatch = (ids) => { for (const r of check.all(JSON.stringify(ids), ...q.check.args)) if (out.length < q.limit) out.push(r.json); };
    const page = Math.max(8, Math.min(512, Math.floor(Math.max(budget.left, 32) / 4 / q.streams.length)));
    const prep = (sql) => { let st = stmts.get(sql); if (!st) stmts.set(sql, (st = db.prepare(sql))); return st; };
    const fill = (s) => {   // kanban #2418: the rest of second s.t below s.rid, then older seconds - both index ranges
      s.buf = prep(s.grp).all(...s.args, s.t, s.rid, page);
      if (s.buf.length < page) s.buf.push(...prep(s.older).all(...s.args, s.t, page - s.buf.length));
      s.pos = 0; s.end = s.buf.length < page;
      if (s.buf.length) { const l = s.buf[s.buf.length - 1]; s.t = l.t; s.rid = l.rid; }
      return s.buf.length > 0;
    };
    const at = (i) => heap[i].buf[heap[i].pos].t;
    const up = (i) => { while (i > 0) { const p = (i - 1) >> 1; if (at(p) >= at(i)) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
    const down = (i) => { for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && at(l) > at(m)) m = l; if (r < heap.length && at(r) > at(m)) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } };
    for (const s0 of q.streams) { const s = { ...s0, t: Number.MAX_SAFE_INTEGER, rid: Number.MAX_SAFE_INTEGER }; if (fill(s)) { heap.push(s); up(heap.length - 1); } }
    let broad = false, batch = [];
    while (heap.length && out.length < q.limit) {
      if (spent()) { broad = true; break; }
      const s = heap[0], row = s.buf[s.pos++]; budget.left--;
      if (!seen.has(row.id)) { seen.add(row.id); batch.push(row.id); budget.work -= cost; }
      if (s.pos >= s.buf.length && (s.end || !fill(s))) { const last = heap.pop(); if (heap.length && last !== s) { heap[0] = last; down(0); } } else down(0);
      if (batch.length >= CHECK_BATCH) { checkBatch(batch); batch = []; }
    }
    if (batch.length && out.length < q.limit) checkBatch(batch);
    return { rows: out, broad: broad && out.length < q.limit };
  };
  // ONE QUERY ENGINE (merge of #1720/#1915 with #1826/#2246/#2378/#2418, kanban #1489): the walk above, over the tags table #1915 keeps -
  // one row per (event, name, value), each with its event's kind and created_at, (id, name, value) unique (tag_key)
  const stored = (filters) => {
    // kanban #2246: one REQ checks at most SCAN_ROWS walked candidates and counts at most 4 x SCAN_ROWS rows to choose its walks, all its
    // filters together; kanban #2378: and at most WORK_ROWS seeks checking candidates, 4 x SCAN_ROWS counting drives
    const out = new Map(), budget = { left: SCAN_ROWS, count: 4 * SCAN_ROWS, drive: 4 * SCAN_ROWS, work: WORK_ROWS };
    let broad = false;
    for (const f of filters) {
      const q = plan(f, budget);
      if (!q) continue;
      let rows;
      if (q.sql) { rows = db.prepare(q.sql).all(...q.args).map((r) => r.json); broad = broad || !!q.broad; }
      else { const r = walkRows(q, budget); rows = r.rows; broad = broad || r.broad; }
      const c = compileFilter(f);   // kanban #2378: the last check by Sets (min of both sides per tag), not tags x values
      for (const json of rows) {
        const e = JSON.parse(json);
        if (!out.has(e.id) && matchesCompiled(c, e, eventTagSets(e))) out.set(e.id, e);
      }
    }
    const events = [...out.values()].sort((a, b) => b.created_at - a.created_at);
    events.broad = broad;
    return events;
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
  // WHO IS SHED IS WHO HAS HELD A BACKLOG LONGEST, NOT WHO HOLDS THE MOST NOW (kanban #2119, #1489 v1-refute-50-s4): a REQ answer is queued
  // in one synchronous loop, so a client reading at full speed holds its whole answer as backlog for that moment - a stranger who spread
  // ~7 MB thinly over paused sockets (each below one honest answer) made the honest reader the largest, and it was the one cut off. Now
  // each 1 s recount marks since when a client has held a backlog (`heldSince`, cleared when it is seen empty); shed() drops the clients
  // that held one at a recount first, the longest-held first (the larger of equal ones), and a backlog built since the last recount
  // (an answer being read) only when nothing held is left.
  const backlog = () => { let n = 0; for (const o of clients) n += o.ws.bufferedAmount; return n; };
  let queued = 0;
  const recount = setInterval(() => {
    const now = Date.now();
    queued = 0;
    for (const o of clients) { const b = o.ws.bufferedAmount; queued += b; if (b > 0) { if (!o.heldSince) o.heldSince = now; } else o.heldSince = 0; }
  }, 1000);
  recount.unref?.();
  const before = (x, y) => (x.heldSince && y.heldSince ? x.heldSince < y.heldSince || (x.heldSince === y.heldSince && x.ws.bufferedAmount > y.ws.bufferedAmount)
    : x.heldSince ? true : y.heldSince ? false : x.ws.bufferedAmount > y.ws.bufferedAmount);
  const shed = () => {
    queued = backlog();
    while (queued > lim.totalSlowBytes) {
      let big = null;
      for (const o of clients) if (o.ws.bufferedAmount && (!big || before(o, big))) big = o;
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
                  if (q && q[dim] > share(Q)) { const h = largest[dim].get(Q, '', keepJson); if (h) victim = oldestIn.get(h.pubkey, Q, e.id); }   // 1.
                  if (!victim) {   // 2.
                    const mine = holderUse.get(e.pubkey, P) || { n: 0, b: 0 }, h = largest[dim].get(P, e.pubkey, keepJson);
                    if (h && (h[dim] > mine[dim] || keepSet.has(e.pubkey))) victim = oldestIn.get(h.pubkey, P, e.id);   // a kept author's write takes from the largest other (#2146)
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
        const found = stored(filters);
        for (const e of found) {
          if (ws.readyState !== 1) return undefined;
          // kanban #1717: the stored answer stops once this socket's unsent backlog passes SLOW_BYTES; the subscription ends
          if (ws.bufferedAmount > SLOW_BYTES) { subs.delete(sid); return send(['CLOSED', sid, 'error: too slow, the answer was cut; ask again with a smaller limit']); }
          queue(c, JSON.stringify(['EVENT', sid, e]));   // kanban #1904: counted toward the relay-wide backlog (may drop this client)
        }
        // kanban #2275: a walk that ran out of its budget says so - the answer may miss older matches
        if (found.broad) send(['NOTICE', `error: filter too broad, this REQ examined ${SCAN_ROWS} rows and some of its filters may miss older matches; narrow them (since/until, fewer values)`]);
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
    close: () => new Promise((r) => { clearInterval(recount); for (const c of clients) c.ws.terminate(); wss.close(); server.close(() => { db.close(); r(); }); }),
  };
}
