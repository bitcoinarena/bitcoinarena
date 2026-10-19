// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE NODES, FOUND ON THE FLY (2026-10-13: "The client may not have a hard coded node list it must be found on
// the fly"). A page starts from any node it can reach (a bootstrap, not a list), and every census it checks itself - each entry's
// bond and advertisement proved against headers it agreed (client-committee.js) - names the network's nodes: each bond's
// advertisement carries the node's endpoint. Those are the nodes this page talks to from then on, kept for its next start.
import { toHex } from '../../arena-protocol/src/hash.js';

/** The https root of a node's advertised endpoint (wss -> https, ws -> http), or null for none. */
export function endpointRoot(endpoint) {
  const s = String(endpoint || '').trim();
  if (!/^(wss?|https?):\/\//i.test(s)) return null;
  return s.replace(/^ws(s?):/i, 'http$1:').replace(/\/+$/, '');
}

/** Every node a checked census names, by its advertised endpoint: one root per node key, in the order of their keys. */
export function censusEndpoints(entries) {
  const byKey = new Map();
  for (const e of entries || []) {
    const root = endpointRoot(e && e.advert && e.advert.endpoint);
    if (!root || !e.pubkey) continue;
    const k = toHex(e.pubkey);
    if (!byKey.has(k)) byKey.set(k, root);
  }
  return [...byKey.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map((x) => x[1]);
}

/** `known` with every root of `found` it lacks, appended - nothing known is dropped or reordered. */
export function mergeNodes(known, found) {
  const out = [...(known || [])];
  const have = new Set(out.map((n) => String(n).replace(/\/+$/, '')));
  for (const n of found || []) { const r = String(n).replace(/\/+$/, ''); if (!have.has(r)) { have.add(r); out.push(r); } }
  return out;
}
