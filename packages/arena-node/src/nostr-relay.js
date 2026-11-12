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
//   - in total at most TOTAL_EVENTS events and TOTAL_BYTES bytes; past that a new event is refused ('blocked: the relay is full');
//   (no cap on sockets per address: behind the tunnel every player comes from the same local address; the quotas bound the disk);
//   - a REQ reads only the rows its ids/authors/kinds/since/until select (SQL on indexed columns), not the whole table.
const AUTHOR_EVENTS = 500, AUTHOR_BYTES = 4 * 1024 * 1024, TOTAL_EVENTS = 200000, TOTAL_BYTES = 512 * 1024 * 1024;
const SLOW_BYTES = 4 * 1024 * 1024;   // kanban #1542: the most one client may leave unread before it is dropped
const HARD_SLOW_BYTES = 2 * SLOW_BYTES;   // kanban #1717: past this backlog no message at all is queued; the client is dropped
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
  if (!Array.isArray(e.tags) || !e.tags.every((t) => Array.isArray(t) && t.every((x) => typeof x === 'string'))) return 'invalid: tags';
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
    CREATE TABLE IF NOT EXISTS tags (id TEXT, name TEXT, value TEXT);
    CREATE INDEX IF NOT EXISTS tag_value ON tags (name, value);
    CREATE INDEX IF NOT EXISTS tag_id ON tags (id);
    CREATE TRIGGER IF NOT EXISTS ev_tags_drop AFTER DELETE ON events BEGIN DELETE FROM tags WHERE id = old.id; END;`);   // kanban #1513: REQs read by index; #1543: tags too
  // kanban #1543: each event's single-letter tags (#p, #e, #d, ...) are kept in their own indexed table so a #<letter> filter is answered from the
  // index; a store written before has them filled in once here.
  const putTag = db.prepare('INSERT INTO tags (id, name, value) VALUES (?, ?, ?)');
  const tagRows = (e) => { for (const t of e.tags) if (t[0].length === 1 && t.length > 1) putTag.run(e.id, t[0], t[1]); };
  if (!db.prepare('SELECT 1 FROM tags LIMIT 1').get()) for (const r of db.prepare('SELECT json FROM events').all()) tagRows(JSON.parse(r.json));
  const put = db.prepare('INSERT OR IGNORE INTO events (id, pubkey, kind, created_at, d, json) VALUES (?, ?, ?, ?, ?, ?)');
  const newest = db.prepare('SELECT id, created_at FROM events WHERE pubkey = ? AND kind = ? AND d = ? ORDER BY created_at DESC, id ASC LIMIT 1');
  const drop = db.prepare('DELETE FROM events WHERE pubkey = ? AND kind = ? AND d = ? AND id != ?');
  const all = db.prepare('SELECT json FROM events ORDER BY created_at DESC');
  // kanban #1513: quotas (see AUTHOR_EVENTS above)
  const authorUse = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(json)), 0) AS b FROM events WHERE pubkey = ?');
  const authorOldest = db.prepare('SELECT id FROM events WHERE pubkey = ? ORDER BY created_at ASC, id DESC LIMIT 1');
  const dropId = db.prepare('DELETE FROM events WHERE id = ?');
  const has = db.prepare('SELECT 1 AS x FROM events WHERE id = ?');
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
  const sqlFor = (f) => {
    const where = [], args = [];
    const hexIn = (col, list) => {   // full 64-hex values by equality, NIP-01 prefixes as an index range [prefix, prefix + 'g')
      const full = list.filter((x) => x.length === 64), pre = list.filter((x) => x.length < 64), or = [];
      if (full.length) { or.push(`${col} IN (${full.map(() => '?').join(',')})`); args.push(...full); }
      for (const x of pre) { or.push(`(${col} >= ? AND ${col} < ?)`); args.push(x, `${x}g`); }
      where.push(`(${or.join(' OR ')})`);
    };
    for (const k of ['ids', 'authors', 'kinds']) if (Array.isArray(f[k]) && !f[k].length) return null;   // an empty list matches nothing
    if (f.ids) hexIn('id', f.ids);
    if (f.authors) hexIn('pubkey', f.authors);
    if (f.kinds) { where.push(`kind IN (${f.kinds.map(() => '?').join(',')})`); args.push(...f.kinds); }
    if (f.since !== undefined) { where.push('created_at >= ?'); args.push(f.since); }
    if (f.until !== undefined) { where.push('created_at <= ?'); args.push(f.until); }
    for (const [k, vals] of Object.entries(f)) {
      if (k[0] !== '#' || k.length !== 2) continue;
      if (!vals.length) return null;
      where.push(`id IN (SELECT id FROM tags WHERE name = ? AND value IN (${vals.map(() => '?').join(',')}))`); args.push(k[1], ...vals);
    }
    args.push(Math.min(Number.isInteger(f.limit) ? f.limit : MAX_LIMIT, MAX_LIMIT));
    return { sql: `SELECT json FROM events${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`, args };
  };
  const stored = (filters) => {
    const out = new Map();
    for (const f of filters) {
      const q = sqlFor(f);
      if (!q) continue;
      for (const row of db.prepare(q.sql).iterate(...q.args)) {
        const e = JSON.parse(row.json);
        if (matches(f, e) && !out.has(e.id)) out.set(e.id, e);
      }
    }
    return [...out.values()].sort((a, b) => b.created_at - a.created_at);
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
  const fanOut = (o, sid, e) => {
    if (o.ws.readyState !== 1) return;
    if (o.ws.bufferedAmount > SLOW_BYTES) return dropSlow(o);
    o.ws.send(JSON.stringify(['EVENT', sid, e]));
  };
  wss.on('connection', (ws) => {
    const subs = new Map();
    const c = { ws, subs };
    clients.add(c);
    let budget = 60, refill = setInterval(() => { budget = Math.min(60, budget + 20); }, 10000);
    const send = (m) => {   // kanban #1717: no message is queued for a client already HARD_SLOW_BYTES behind
      if (ws.readyState !== 1) return;
      if (ws.bufferedAmount > HARD_SLOW_BYTES) return dropSlow(c);
      ws.send(JSON.stringify(m));
    };
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
            if (total.n + 1 > lim.totalEvents || total.b + json.length > lim.totalBytes) return send(['OK', e.id, false, 'blocked: the relay is full']);
            const before = authorUse.get(e.pubkey);
            if (put.run(e.id, e.pubkey, e.kind, e.created_at, d, json).changes) tagRows(e);   // kanban #1543: its tags indexed with it
            if (isReplaceable(e.kind) || isParam(e.kind)) drop.run(e.pubkey, e.kind, d, e.id);
            let use = authorUse.get(e.pubkey);
            while (use.n > 1 && (use.n > lim.authorEvents || use.b > lim.authorBytes)) {
              const old = authorOldest.get(e.pubkey);
              if (!old) break;
              dropId.run(old.id);
              use = authorUse.get(e.pubkey);
            }
            total.n += use.n - before.n; total.b += use.b - before.b;   // only this author's rows changed
            if (!has.get(e.id)) return send(['OK', e.id, false, 'blocked: older than all this author already has, over the quota']);
          }
        }
        send(['OK', e.id, true, '']);
        for (const o of clients) for (const [sid, fs] of o.subs) if (fs.some((f) => matches(f, e))) fanOut(o, sid, e);
        return undefined;
      }
      if (m[0] === 'REQ') {
        const sid = String(m[1] || '');
        const filters = m.slice(2).filter((f) => f && typeof f === 'object');
        if (!sid || sid.length > 64) return send(['CLOSED', sid, 'invalid: subscription id']);
        if (!filters.length || filters.length > MAX_FILTERS) return send(['CLOSED', sid, `invalid: 1 to ${MAX_FILTERS} filters`]);
        { const bad = filters.map(filterRefusal).find(Boolean); if (bad) return send(['CLOSED', sid, `invalid: ${bad}`]); }   // kanban #1470
        if (!subs.has(sid) && subs.size >= MAX_SUBS) return send(['CLOSED', sid, `blocked: at most ${MAX_SUBS} subscriptions`]);
        subs.set(sid, filters);
        for (const e of stored(filters)) {
          if (ws.readyState !== 1) return undefined;
          // kanban #1717: the stored answer stops once this socket's unsent backlog passes SLOW_BYTES; the subscription ends
          if (ws.bufferedAmount > SLOW_BYTES) { subs.delete(sid); return send(['CLOSED', sid, 'error: too slow, the answer was cut; ask again with a smaller limit']); }
          ws.send(JSON.stringify(['EVENT', sid, e]));
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
    close: () => new Promise((r) => { for (const c of clients) c.ws.terminate(); wss.close(); server.close(() => { db.close(); r(); }); }),
  };
}
