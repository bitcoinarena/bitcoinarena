// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A FEDERATION'S RESERVE SEATS FROM THE CENSUS (§27A.9.2, kanban #397): every census entry whose advertisement names the federation
// in guardian_of - ONE SEAT PER NODE KEY. Measured 2026-10-22 03:4xZ: test host seat 1 (2fca1090) holds two bonds since a bond was added
// from the owner page (#553), so the census carries it twice, both naming federation A; A's reserve committee listed it twice (8, not
// 7), the reserve epoch refused "two signer nodes of that committee are one key", A never got a reserve key, and GET /reserves
// answered 400 on all 14 seats.
import { toHex } from '../../arena-protocol/src/hash.js';

//
// ONLY A GUARDIAN THE FEDERATION'S RECORD NAMES (kanban #1204 RES-1): an advert's guardian_of is the node's own word, and one bonded
// node naming federation A with any key joined A's reserve committee - the epoch moved, the DKG waited for a share it never dealt, and A
// had no reserve key: every paid entry into A refused, its markets paused (with enough such nodes, the reserve key theirs). With
// `guardiansOf(fedHex)` - the guardians of the federation's record this seat holds, signed by its threshold - an entry counts only when
// that record names its node key AND the guardian key its advert gives; one node per guardian key. A federation whose record this seat
// does not hold (guardiansOf answers null) is read as before.
/** { federation hex: [entry, ...] } - each node once per federation, its first entry kept (the census order). */
export function reserveMembersOf(entries, { guardiansOf = null } = {}) {
  const out = {};
  const seen = {};
  const keysSeen = {};
  const named = new Map();   // federation hex -> Map(node hex -> peer key hex) of its record, or null
  const namedOf = (f) => {
    if (!named.has(f)) {
      let gs = null; try { gs = typeof guardiansOf === 'function' ? guardiansOf(f) : null; } catch { gs = null; }
      named.set(f, Array.isArray(gs) ? new Map(gs.map((g) => [toHex(g.nodePubkey), toHex(g.peerKey)])) : null);
    }
    return named.get(f);
  };
  for (const e of entries || []) for (const g of (e && e.advert && e.advert.guardianOf) || []) {
    const f = toHex(g.federationId), node = toHex(e.pubkey);
    (seen[f] = seen[f] || new Set());
    if (seen[f].has(node)) continue;
    const rec = namedOf(f);
    if (rec) {
      const key = g.guardianKey ? toHex(g.guardianKey) : null;
      if (!key || rec.get(node) !== key) continue;
      (keysSeen[f] = keysSeen[f] || new Set());
      if (keysSeen[f].has(key)) continue;
      keysSeen[f].add(key);
    }
    seen[f].add(node);
    (out[f] = out[f] || []).push(e);
  }
  return out;
}
