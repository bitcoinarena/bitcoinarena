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
//     (nobody else's; its regular events and round results before its one-per-key events, kanban #1621), so a node's newest
//     round results and badges, and its badge definitions, are always kept;
//   - in total at most TOTAL_EVENTS events and TOTAL_BYTES bytes; past that a new regular event is refused ('blocked: the relay is full'),
//     a replaceable or parameterized one pushes out the oldest event of the author holding the most (kanban #1620);
//   (no cap on sockets per address: behind the tunnel every player comes from the same local address; the quotas bound the disk);
//   - a REQ reads only the rows its ids/authors/kinds/since/until select (SQL on indexed columns), not the whole table.
const AUTHOR_EVENTS = 500, AUTHOR_BYTES = 4 * 1024 * 1024, TOTAL_EVENTS = 200000, TOTAL_BYTES = 512 * 1024 * 1024;
const SLOW_BYTES = 4 * 1024 * 1024;   // kanban #1542: the most one client may leave unread before it is dropped
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
  // kanban #1753: every tag has at least its name - an empty tag ([]) passed here, then threw in tagRows after the row was kept, past the quotas
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
    CREATE TABLE IF NOT EXISTS tags (id TEXT, name TEXT, value TEXT, created_at INTEGER);
    CREATE INDEX IF NOT EXISTS tag_value ON tags (name, value);
    CREATE INDEX IF NOT EXISTS tag_id ON tags (id);
    CREATE TRIGGER IF NOT EXISTS ev_tags_drop AFTER DELETE ON events BEGIN DELETE FROM tags WHERE id = old.id; END;`);   // kanban #1513: REQs read by index; #1543: tags too
  // A TAG IS READ NEWEST FIRST FROM ITS OWN INDEX (kanban #2246, #2258, #2275; #1489 a45-refute-11): each tag row carries its event's
  // created_at, so a #<letter> condition is walked newest first from tags (name, value, created_at) instead of a correlated EXISTS over
  // the whole store; (id, name, value) makes the EXISTS that checks a tag on one row an index seek, however many tags that event repeats;
  // events (pubkey, created_at) walks an author newest first. A store written before gets the column and its values once here (and any
  // row written without one, on every start, through tag_unfilled).
  if (!db.prepare('PRAGMA table_info(tags)').all().some((c) => c.name === 'created_at')) db.exec('ALTER TABLE tags ADD COLUMN created_at INTEGER');
  // kanban #2378, #2380 (#1489 a45-refute-11-s2-2): each tag row also carries its event's kind, so {kinds:[K],"#p":[R]} is walked newest first
  // from tags (name, value, kind, created_at) - only R's own kind-K events - and no flood of other kinds or of K to others can bury them.
  if (!db.prepare('PRAGMA table_info(tags)').all().some((c) => c.name === 'kind')) db.exec('ALTER TABLE tags ADD COLUMN kind INTEGER');
  db.exec(`CREATE INDEX IF NOT EXISTS tag_value_time ON tags (name, value, created_at);
    CREATE INDEX IF NOT EXISTS tag_id_nv ON tags (id, name, value);
    CREATE INDEX IF NOT EXISTS tag_unfilled ON tags (id) WHERE created_at IS NULL;
    CREATE INDEX IF NOT EXISTS ev_author_time ON events (pubkey, created_at);
    UPDATE tags INDEXED BY tag_unfilled SET created_at = COALESCE((SELECT created_at FROM events WHERE events.id = tags.id), 0) WHERE created_at IS NULL;
    CREATE INDEX IF NOT EXISTS tag_value_kind_time ON tags (name, value, kind, created_at);
    CREATE INDEX IF NOT EXISTS tag_nokind ON tags (id) WHERE kind IS NULL;
    UPDATE tags INDEXED BY tag_nokind SET kind = COALESCE((SELECT kind FROM events WHERE events.id = tags.id), -1) WHERE kind IS NULL;`);
  // kanban #1543: each event's single-letter tags (#p, #e, #d, ...) are kept in their own indexed table so a #<letter> filter is answered from the
  // index; a store written before has them filled in once here.
  const putTag = db.prepare('INSERT INTO tags (id, name, value, created_at, kind) VALUES (?, ?, ?, ?, ?)');
  // kanban #1753: a tag that is not [name, value, ...] of strings is skipped (a store may hold one kept before the door refused it)
  // kanban #2258: each (name, value) once per event - an event repeating [a, x] a thousand times is one row, not a thousand
  const tagRows = (e) => {
    const seen = new Set();
    for (const t of (Array.isArray(e.tags) ? e.tags : [])) {
      if (!(Array.isArray(t) && t.length > 1 && typeof t[0] === 'string' && t[0].length === 1 && typeof t[1] === 'string')) continue;
      const k = `${t[0]}\u0000${t[1]}`;
      if (!seen.has(k)) { seen.add(k); putTag.run(e.id, t[0], t[1], Number.isInteger(e.created_at) ? e.created_at : 0, Number.isInteger(e.kind) ? e.kind : -1); }
    }
  };
  if (!db.prepare('SELECT 1 FROM tags LIMIT 1').get()) for (const r of db.prepare('SELECT json FROM events').all()) tagRows(JSON.parse(r.json));
  const put = db.prepare('INSERT OR IGNORE INTO events (id, pubkey, kind, created_at, d, json) VALUES (?, ?, ?, ?, ?, ?)');
  const newest = db.prepare('SELECT id, created_at FROM events WHERE pubkey = ? AND kind = ? AND d = ? ORDER BY created_at DESC, id ASC LIMIT 1');
  const drop = db.prepare('DELETE FROM events WHERE pubkey = ? AND kind = ? AND d = ? AND id != ?');
  const all = db.prepare('SELECT json FROM events ORDER BY created_at DESC');
  // kanban #1513: quotas (see AUTHOR_EVENTS above)
  const authorUse = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(json)), 0) AS b FROM events WHERE pubkey = ?');
  // kanban #1621 (#1489 r4-nostr-2): the oldest by created_at alone was always a node's badge definitions (kind 30009, dated
  // BADGES_AT_S and published once), so ~500 rounds later its awards named definitions the relay no longer held. An author's
  // one-per-key events (replaceable: 0, 3, 10000-19999; parameterized replaceable but not a round's own 30762) now go only
  // after all its regular events and round results are gone; among each group the oldest still goes first.
  const authorOldest = db.prepare(`SELECT id FROM events WHERE pubkey = ? ORDER BY
    (kind = 0 OR kind = 3 OR (kind >= 10000 AND kind < 20000) OR (kind >= 30000 AND kind < 40000 AND kind != 30762)) ASC,
    created_at ASC, id DESC LIMIT 1`);
  const dropId = db.prepare('DELETE FROM events WHERE id = ?');
  const has = db.prepare('SELECT 1 AS x FROM events WHERE id = ?');
  const heaviest = db.prepare('SELECT pubkey FROM events GROUP BY pubkey ORDER BY COUNT(*) DESC, pubkey ASC LIMIT 1');   // kanban #1620
  const totalUse = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(json)), 0) AS b FROM events');
  const lim = { authorEvents: AUTHOR_EVENTS, authorBytes: AUTHOR_BYTES, totalEvents: TOTAL_EVENTS, totalBytes: TOTAL_BYTES, ...limits };
  const total = { ...totalUse.get() };
  const clients = new Set();
  const info = { name, description, supported_nips: [1, 11, 42, 46, 47, 57, 58, 65, 78], software: 'arena-node/nostr-relay', version: '1',
    limitation: { max_message_length: MAX_EVENT_BYTES, max_subscriptions: MAX_SUBS, max_filters: MAX_FILTERS, max_limit: MAX_LIMIT }, kinds };
  const server = createServer((req, res) => {
    // NIP-11: the information document; anything else is a short page
    res.writeHead(200, { 'content-type': /nostr\+json/.test(req.headers.accept || '') ? 'application/nostr+json' : 'text/plain; charset=utf-8',
      'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET' });
    res.end(/nostr\+json/.test(req.headers.accept || '') ? JSON.stringify(info) : `${name}: a Nostr relay (wss). ${description}\n`);
  });
  const wss = new WebSocketServer({ server, maxPayload: MAX_EVENT_BYTES * 2 });
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
  const DRIVE_ROWS = 2000, SCAN_ROWS = 20000, CHECK_BATCH = 250, WORK_ROWS = 4 * SCAN_ROWS;
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
      const tc = { where: `EXISTS (SELECT 1 FROM tags t INDEXED BY tag_id_nv WHERE t.id = e.id AND t.name = ? AND t.${inV})`, args, cost: uv.length, seeks: uv.length,
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
      const cap = Math.min(SCAN_ROWS, walk ? walk.n : SCAN_ROWS, budget.count);
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
  const fanOut = (o, sid, e) => {
    if (o.ws.readyState !== 1) return;
    if (o.ws.bufferedAmount > SLOW_BYTES) { clients.delete(o); try { o.ws.send(JSON.stringify(['NOTICE', 'error: too slow, the relay stopped sending'])); } catch { /* gone */ } o.ws.terminate(); return; }
    o.ws.send(JSON.stringify(['EVENT', sid, e]));
  };
  wss.on('connection', (ws) => {
    const subs = new Map();
    const c = { ws, subs };
    clients.add(c);
    let budget = 60, refill = setInterval(() => { budget = Math.min(60, budget + 20); }, 10000);
    const send = (m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };
    ws.on('close', () => { clients.delete(c); clearInterval(refill); });
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
            // kanban #1513: the relay's total first (refused when full), then the author's own quota (their oldest goes)
            // A FULL RELAY STILL TAKES THE GAME'S STATE (kanban #1620, #1489 r4-nostr-1): keys are free, so strangers filled the total with
            // regular events (kind 8 / 9735) 500 at a time under ~400 keys, each inside its own quota, and from then on every author was
            // refused - a new player's game seed (30078, the login failed), every node's round result (30762, which publishPass never sends
            // again). Past the total a regular event is still refused; a replaceable or parameterized one (one per author, kind and `d`:
            // profile, relay list, seed, result, badge definition) makes room instead: the oldest event of the author holding the most goes.
            const isFull = () => total.n + 1 > lim.totalEvents || total.b + json.length > lim.totalBytes;
            if (isFull() && (isReplaceable(e.kind) || isParam(e.kind))) {
              for (let guard = 0; isFull() && guard < 64; guard++) {
                const h = heaviest.get();
                const old = h && authorOldest.get(h.pubkey);
                if (!old) break;
                const u0 = authorUse.get(h.pubkey);
                dropId.run(old.id);
                const u1 = authorUse.get(h.pubkey);
                total.n += u1.n - u0.n; total.b += u1.b - u0.b;
              }
            }
            if (isFull()) return send(['OK', e.id, false, 'blocked: the relay is full']);
            // kanban #1753: the insert, its tags, the replaceable drop and the quota are one transaction - a throw part way rolls the row back,
            // so no event is ever kept without its quota and total counted
            const before = authorUse.get(e.pubkey);
            let use;
            db.exec('BEGIN');
            try {
              if (put.run(e.id, e.pubkey, e.kind, e.created_at, d, json).changes) tagRows(e);   // kanban #1543: its tags indexed with it
              if (isReplaceable(e.kind) || isParam(e.kind)) drop.run(e.pubkey, e.kind, d, e.id);
              use = authorUse.get(e.pubkey);
              while (use.n > 1 && (use.n > lim.authorEvents || use.b > lim.authorBytes)) {
                const old = authorOldest.get(e.pubkey);
                if (!old) break;
                dropId.run(old.id);
                use = authorUse.get(e.pubkey);
              }
              db.exec('COMMIT');
            } catch (err) { try { db.exec('ROLLBACK'); } catch { /* none open */ } throw err; }
            total.n += use.n - before.n; total.b += use.b - before.b;   // only this author's rows changed (counted after the commit)
            if (!has.get(e.id)) return send(['OK', e.id, false, 'blocked: older than all this author already has, over the quota']);
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
        for (const e of found) send(['EVENT', sid, e]);
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
    close: () => new Promise((r) => { for (const c of clients) c.ws.terminate(); wss.close(); server.close(() => { db.close(); r(); }); }),
  };
}
