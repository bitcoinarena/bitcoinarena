// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A FEDERATION'S RESERVE SEATS FROM THE CENSUS (§27A.9.2, kanban #397): every census entry whose advertisement names the federation
// in guardian_of - ONE SEAT PER NODE KEY. Measured 2026-10-22 03:4xZ: test host seat 1 (2fca1090) holds two bonds since a bond was added
// from the owner page (#553), so the census carries it twice, both naming federation A; A's reserve committee listed it twice (8, not
// 7), the reserve epoch refused "two signer nodes of that committee are one key", A never got a reserve key, and GET /reserves
// answered 400 on all 14 seats.
import { toHex } from '../../arena-protocol/src/hash.js';

/** { federation hex: [entry, ...] } - each node once per federation, its first entry kept (the census order). */
export function reserveMembersOf(entries) {
  const out = {};
  const seen = {};
  for (const e of entries || []) for (const g of (e && e.advert && e.advert.guardianOf) || []) {
    const f = toHex(g.federationId), node = toHex(e.pubkey);
    (seen[f] = seen[f] || new Set());
    if (seen[f].has(node)) continue;
    seen[f].add(node);
    (out[f] = out[f] || []).push(e);
  }
  return out;
}
