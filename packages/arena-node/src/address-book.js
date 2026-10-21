// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ADDRESSES THIS SEAT KNOWS, OFF CHAIN (arena-protocol address-announcement.js, kanban #562): every node's newest valid address
// announcement, kept in the node's store so a restart keeps them. POST /address-announcement hands one in, GET
// /address-announcements lists them; the seat's P2P tunnel and the founding's code exchange find a node at endpointOf(entry, map()).
// This seat's own: signed whenever the address it names itself (ARENA_WSS_<port>) is not the one it last announced, and pushed to
// every census node's seat once in a while (announceOwn), so a node whose census endpoint went stale is found again at once.
import { checkAddressAnnouncement, newerAnnouncement, signAddressAnnouncement, endpointOf } from '../../arena-protocol/src/address-announcement.js';

export function createAddressBook({ db, verify, nowMs = () => Date.now() }) {
  db.exec('CREATE TABLE IF NOT EXISTS address_announcements (node TEXT PRIMARY KEY, body TEXT NOT NULL)');
  const map = new Map();
  for (const r of db.prepare('SELECT body FROM address_announcements').all()) {
    try { const a = JSON.parse(r.body); if (checkAddressAnnouncement(a, { verify, nowMs: nowMs() }).ok) map.set(a.node, a); } catch { /* a row that does not read */ }
  }
  /** Take one in: checked, kept when it is the node's newest. Answers { ok, kept, why }. */
  function take(a) {
    const c = checkAddressAnnouncement(a, { verify, nowMs: nowMs() });
    if (!c.ok) return { ok: false, why: c.why };
    const clean = { node: a.node, endpoint: a.endpoint, atMs: a.atMs, sig: a.sig };
    const have = map.get(clean.node);
    if (newerAnnouncement(have, clean) === have) return { ok: true, kept: false };
    map.set(clean.node, clean);
    db.prepare('INSERT INTO address_announcements (node, body) VALUES (?, ?) ON CONFLICT(node) DO UPDATE SET body = excluded.body').run(clean.node, JSON.stringify(clean));
    return { ok: true, kept: true };
  }
  /** This node's own, for the address it names itself: the one kept when it names it, else a new one, signed now. */
  function own({ node, endpoint, sign }) {
    const have = map.get(String(node).toLowerCase());
    if (have && have.endpoint === endpoint) return have;
    const a = signAddressAnnouncement({ node, endpoint, atMs: nowMs() }, sign);
    take(a);
    return a;
  }
  return { take, own, map: () => map, list: () => [...map.values()], endpointOf: (entry) => endpointOf(entry, map) };
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
