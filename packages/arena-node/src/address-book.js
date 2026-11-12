// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ADDRESSES THIS SEAT KNOWS, OFF CHAIN (arena-protocol address-announcement.js, kanban #562): every node's newest valid address
// announcement, kept in the node's store so a restart keeps them. POST /address-announcement hands one in, GET
// /address-announcements lists them; the seat's P2P tunnel and the founding's code exchange find a node at endpointOf(entry, map()).
// This seat's own: signed whenever the address it names itself (ARENA_WSS_<port>) is not the one it last announced, and pushed to
// every census node's seat once in a while (announceOwn), so a node whose census endpoint went stale is found again at once.
import { checkAddressAnnouncement, newerAnnouncement, signAddressAnnouncement, endpointOf } from '../../arena-protocol/src/address-announcement.js';

// BOUNDED, AND ONLY CENSUS NODES (kanban #1533, wf1489 round 2: one peer's GET /address-announcements listing 2000 self-signed keys
// with 4 KB endpoints added 2000 rows, 8.5 MB, to every seat that pulled it, and each served them all again). An endpoint longer than
// ADDRESS_ENDPOINT_MAX is refused; the book holds at most ADDRESS_BOOK_MAX nodes (a node already held still updates); `isCensusNode`
// (hex key -> true / false / null for "no census read yet") refuses a key the seat's census does not name, with status 409.
export const ADDRESS_ENDPOINT_MAX = 256;
export const ADDRESS_BOOK_MAX = 4096;
// NOT IN THE CENSUS YET, FOUND BY KEY ONLY (kanban #2066, wf1489 refute of #1533): a node just installed on a remote server has no bond,
// so no census names it, and since #1533 every seat refused its announcement - the owner page on the Arena site (pages/owner.html
// siteBase, the installer's OWNER_SITE#node=<key> link) finds a node only through the seats, so it never found it, and the first bond
// (#728) could not be set up from that link. Such an announcement (checked, bounded endpoint) is still answered 409, but held in a small
// bucket: at most ADDRESS_PENDING_MAX nodes, the least recently announced one goes first, in memory only. It is never served in the
// plain GET /address-announcements, so never pulled by other seats, never used by endpointOf, never counted - only answered for a lookup
// by that key (list({ node }), GET /address-announcements?node=<key>). Once the census names the node it moves into the book.
export const ADDRESS_PENDING_MAX = 256;

export function createAddressBook({ db, verify, nowMs = () => Date.now(), isCensusNode = () => null, censusKeys = null, ownKey = null }) {
  db.exec('CREATE TABLE IF NOT EXISTS address_announcements (node TEXT PRIMARY KEY, body TEXT NOT NULL)');
  // THE BOUNDS HOLD FOR WHAT IS HELD, NOT ONLY AT THE DOOR (kanban #1712, #1778, wf1489 refute of #1533): an announcement taken while
  // no census was read yet (isCensusNode -> null, the first minute after a start) stayed in the book and was served, counted and used
  // as a seat URL for good once the census named other keys; and rows stored before #1533 (4 KB endpoints, any key, more than
  // ADDRESS_BOOK_MAX) were read back at a start with the signature check only. Now: a held node the census does not name is dropped
  // from the book (never served at GET /address-announcements, never an endpoint, not counted) as soon as the census is read; this
  // node's own is kept. The load applies take()'s bounds. Stored rows are never deleted (a pruned one is marked, kanban #1906) - an
  // honest node's newer announcement overwrites its row.
  let me = ownKey ? String(ownKey).toLowerCase() : null;
  const kept = (a) => a.node === me || isCensusNode(a.node) !== false;
  // A PRUNED ROW TAKES NO PLACE AT THE NEXT START (kanban #1906, #1949, wf1489 refute of #1533): rows pruned from the book stayed
  // in the store unmarked, so the load - before any census is read - filled ADDRESS_BOOK_MAX with a stranger's rows from the first
  // minute and an honest census node's newer row stored after them was never read back. A pruned row is now marked (`pruned`, never
  // deleted) and skipped at load; and when the load stops at the cap, the rows it did not read are read again once the census is
  // known (refill), census nodes first in line. take() clears the mark of the row it writes.
  try { db.exec('ALTER TABLE address_announcements ADD COLUMN pruned INTEGER NOT NULL DEFAULT 0'); } catch { /* there already */ }
  const censusKnown = () => isCensusNode('') !== null;
  const readRow = (body) => {
    try {
      const a = JSON.parse(body);
      if (!checkAddressAnnouncement(a, { verify, nowMs: nowMs() }).ok) return null;
      if (String(a.endpoint).length > ADDRESS_ENDPOINT_MAX) return null;
      return { node: a.node, endpoint: a.endpoint, atMs: a.atMs, sig: a.sig };
    } catch { return null; }
  };
  const markPruned = (nodes) => {
    if (!nodes.length) return;
    for (const n of nodes) prunedKeys.add(n);
    try { db.prepare('UPDATE address_announcements SET pruned = 1 WHERE node IN (SELECT value FROM json_each(?))').run(JSON.stringify(nodes)); } catch { /* the next prune */ }
  };
  let map = new Map();
  let needRefill = false;
  const pending = new Map();   // kanban #2066: node -> announcement, oldest first
  // PRUNING IS NOT FOR GOOD (kanban #2085, wf1489 refute of #1533): one census read without an honest node (a bond renewal gap, or
  // censusForAddresses' fallback to fedRecords.censusNewestAt) pruned its row, and nothing read it back when the census named it again,
  // nor at the next start: the seat dialed its dead census endpoint until it announced again. The keys of pruned rows are kept here
  // (keys only); whenever the census is known, a pruned row of a node it names is read back (checked as at load) and its mark cleared.
  // `censusKeys` (optional, -> iterable of hex keys or null) lets that pass walk the census instead of every pruned key.
  const prunedKeys = new Set();
  try { for (const r of db.prepare('SELECT node FROM address_announcements WHERE pruned = 1').all()) prunedKeys.add(r.node); } catch { /* none */ }
  for (const r of db.prepare('SELECT body FROM address_announcements WHERE pruned = 0').all()) {
    if (map.size >= ADDRESS_BOOK_MAX) { needRefill = true; break; }
    const a = readRow(r.body);
    if (a && kept(a)) map.set(a.node, a);
  }
  /** With the census known: the rows of census nodes the book does not hold are read in (up to the cap), the rest marked pruned. */
  function refill() {
    const mark = [];
    for (const r of db.prepare('SELECT node, pruned FROM address_announcements').all()) {
      if (map.has(r.node)) continue;
      const named = r.node === me || isCensusNode(r.node) === true;
      if (!named) { if (!r.pruned) mark.push(r.node); continue; }
      if (map.size >= ADDRESS_BOOK_MAX) continue;
      const row = db.prepare('SELECT body FROM address_announcements WHERE node = ?').get(r.node);
      const a = row ? readRow(row.body) : null;
      if (a && a.node === r.node) map.set(a.node, a);
    }
    markPruned(mark);
  }
  /** Held and written: take()'s write (the row's pruned mark cleared). */
  function store(clean) {
    map.set(clean.node, clean);
    pending.delete(clean.node); prunedKeys.delete(clean.node);
    db.prepare('INSERT INTO address_announcements (node, body, pruned) VALUES (?, ?, 0) ON CONFLICT(node) DO UPDATE SET body = excluded.body, pruned = 0').run(clean.node, JSON.stringify(clean));
  }
  /** kanban #2085, #2066: census nodes back in the book - their pruned rows read again, and their pending announcements taken. */
  function restore() {
    if (prunedKeys.size) {
      let keys = null;
      try { const c = censusKeys && censusKeys(); if (c) keys = [...c].map((k) => String(k).toLowerCase()).filter((k) => prunedKeys.has(k)); } catch { keys = null; }
      if (!keys) keys = [...prunedKeys].filter((k) => isCensusNode(k) === true);
      const back = [];
      for (const k of keys) {
        if (map.has(k)) { prunedKeys.delete(k); continue; }
        if (map.size >= ADDRESS_BOOK_MAX) break;
        const row = db.prepare('SELECT body FROM address_announcements WHERE node = ?').get(k);
        const a = row ? readRow(row.body) : null;
        prunedKeys.delete(k);   // a row that does not check stays marked in the store, and is not read again
        if (a && a.node === k) { map.set(k, a); back.push(k); }
      }
      if (back.length) db.prepare('UPDATE address_announcements SET pruned = 0 WHERE node IN (SELECT value FROM json_each(?))').run(JSON.stringify(back));
    }
    for (const [k, a] of [...pending]) {
      if (isCensusNode(k) !== true) continue;
      pending.delete(k);
      if (!map.has(k) && map.size >= ADDRESS_BOOK_MAX) continue;
      const have = map.get(k);
      if (newerAnnouncement(have, a) !== have) store(a);
    }
  }
  /** Drops every held node the census (now read) does not name, this node's own apart. Answers how many went. */
  function prune() {
    const gone = [];
    for (const a of map.values()) if (!kept(a)) gone.push(a.node);
    if (gone.length) {
      if (map.size >= ADDRESS_BOOK_MAX) needRefill = true;   // a row the full book could not take may be a census node's (kanban #1949)
      map = new Map([...map].filter(([, a]) => kept(a)));
      markPruned(gone);   // kanban #1906: it takes no place at the next start
    }
    if (needRefill && censusKnown()) { needRefill = false; try { refill(); } catch { needRefill = true; } }
    if (censusKnown()) { try { restore(); } catch { /* the next prune */ } }
    return gone.length;
  }
  /** Take one in: checked, kept when it is the node's newest. Answers { ok, kept, why }. */
  function take(a, { self = false } = {}) {
    const c = checkAddressAnnouncement(a, { verify, nowMs: nowMs() });
    if (!c.ok) return { ok: false, why: c.why };
    if (String(a.endpoint).length > ADDRESS_ENDPOINT_MAX) return { ok: false, status: 400, why: `an endpoint of at most ${ADDRESS_ENDPOINT_MAX} characters` };
    if (!self && a.node !== me && isCensusNode(a.node) === false) {
      // kanban #2066: held for a lookup by its key only (bounded, the least recently announced goes first)
      const clean = { node: a.node, endpoint: a.endpoint, atMs: a.atMs, sig: a.sig };
      const have = pending.get(clean.node);
      pending.delete(clean.node);
      pending.set(clean.node, newerAnnouncement(have, clean) || clean);
      while (pending.size > ADDRESS_PENDING_MAX) pending.delete(pending.keys().next().value);
      return { ok: false, status: 409, why: 'not a node of this seat\'s census' };
    }
    prune();   // junk held from before the census was read does not take a place (kanban #1712)
    if (!map.has(a.node) && map.size >= ADDRESS_BOOK_MAX) return { ok: false, status: 409, why: 'the address book is full' };
    const clean = { node: a.node, endpoint: a.endpoint, atMs: a.atMs, sig: a.sig };
    const have = map.get(clean.node);
    if (newerAnnouncement(have, clean) === have) return { ok: true, kept: false };
    store(clean);
    return { ok: true, kept: true };
  }
  /** This node's own, for the address it names itself: the one kept when it names it, else a new one, signed now. */
  function own({ node, endpoint, sign }) {
    me = String(node).toLowerCase();
    const have = map.get(me);
    if (have && have.endpoint === endpoint) return have;
    const a = signAddressAnnouncement({ node, endpoint, atMs: nowMs() }, sign);
    take(a, { self: true });   // this node's own, kept before its bond is in the census (kanban #1533)
    return a;
  }
  const held = { get: (k) => { const a = map.get(k); return a && kept(a) ? a : undefined; } };
  /** Every node the book holds; with `node`, also that one key's announcement held outside the census (kanban #2066), if any. */
  function list({ node } = {}) {
    prune();
    const out = [...map.values()];
    const k = node == null ? null : String(node).toLowerCase();
    if (k && !map.has(k) && pending.has(k)) out.push(pending.get(k));
    return out;
  }
  return { take, own, prune, map: () => { prune(); return map; }, list, endpointOf: (entry) => endpointOf(entry, held) };
}

/** Push this node's announcement to every census node's seat at the address it is found at; answers how many took it. */
export async function announceOwn({ announcement, entries, book, ownKey, post }) {
  const own = String(ownKey).toLowerCase();
  const roots = new Set();
  for (const e of entries || []) {
    const key = Buffer.from(e.pubkey).toString('hex');
    if (key === own) continue;
    const at = book.endpointOf(e);
    if (at) roots.add(String(at).replace(/^ws(s?):/i, 'http$1:').replace(/\/+$/, ''));
  }
  let took = 0;
  await Promise.all([...roots].map(async (root) => { try { if (await post(`${root}/address-announcement`, announcement)) took++; } catch { /* the next round */ } }));
  return { roots: roots.size, took };
}

/**
 * AND PULLED, NOT ONLY PUSHED (kanban #577, measured 2026-10-26: after the 1.9.8 update inst577-2 and -3 took new quick tunnels and
 * announced them to the seats they reached - 30 of 51 - and inst577-1, not among them, kept relaying its guardian's API to their old
 * addresses: "connection closed" for those peers, the federation's consensus stalled). Up to `count` census seats asked for their
 * GET /address-announcements; each entry taken as a pushed one is (checked, the node's newest kept). Answers { asked, answered, kept }.
 */
export async function pullAnnouncements({ entries, book, ownKey, get, count = 8, random = Math.random }) {
  const own = String(ownKey).toLowerCase();
  const roots = [];
  for (const e of entries || []) {
    const key = Buffer.from(e.pubkey).toString('hex');
    if (key === own) continue;
    const at = book.endpointOf(e);
    if (at) roots.push(String(at).replace(/^ws(s?):/i, 'http$1:').replace(/\/+$/, ''));
  }
  // kanban #1533: only announcements of nodes this census names are taken, at most as many per answer as the census has nodes
  const census = new Set((entries || []).map((e) => Buffer.from(e.pubkey).toString('hex')));
  const picked = [...new Set(roots)].map((r) => [random(), r]).sort((a, b) => a[0] - b[0]).slice(0, count).map(([, r]) => r);
  let answered = 0, kept = 0;
  await Promise.all(picked.map(async (root) => {
    try {
      const body = await get(`${root}/address-announcements`);
      const list = body && Array.isArray(body.announcements) ? body.announcements : [];
      answered++;
      for (const a of list.filter((x) => x && census.has(String(x.node))).slice(0, census.size)) { try { if (book.take(a).kept) kept++; } catch { /* the next one */ } }
    } catch { /* the next round */ }
  }));
  return { asked: picked.length, answered, kept };
}
