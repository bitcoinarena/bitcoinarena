// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A ROUND'S SIGNER NODES OUTSIDE THE SEATS A TOOL KNOWS, AT THEIR OWN ADDRESSES (kanban #804, measured 2026-10-30 08:42Z, federation B
// Up/Down round 76c7d631: six signer nodes, two of them installed nodes outside the 14 seats; the tools asked only their NODES, so "4 of 6
// signer nodes attest this claim key, and this round needs 5" though both installed nodes served it, and they were never handed their
// shares). Each signer's endpoint comes from the seats' address book (GET /address-announcements); only http(s) - a seat's ws(s)://
// guardian address is no door - and none the tool already asks.
import { toHex } from '../../arena-protocol/src/hash.js';

const strip = (u) => String(u).replace(/\/+$/, '');

/** A reader of the seats' address book, read at most every `everyMs`. */
export function addressBook(nodes, { fetcher = fetch, everyMs = 300000, now = () => Date.now() } = {}) {
  let kept = { at: -Infinity, map: new Map() };
  const read = async () => {
    if (now() - kept.at <= everyMs) return kept.map;
    for (const n of nodes) {
      try {
        const r = await fetcher(`${strip(n)}/address-announcements`, { signal: AbortSignal.timeout(15000) });
        if (!r.ok) continue;
        const j = await r.json();
        kept = { at: now(), map: new Map((j.announcements || []).map((x) => [String(x.node).toLowerCase(), x.endpoint])) };
        break;
      } catch { /* the next seat */ }
    }
    return kept.map;
  };
  /** The endpoints of `signers` (keys, hex or bytes) that `nodes` does not hold already. */
  const outside = async (signers) => {
    const map = await read(); const mine = new Set(nodes.map(strip));
    const out = [];
    for (const k of signers || []) {
      const e = map.get((typeof k === 'string' ? k : toHex(k)).toLowerCase());
      if (e && /^https?:\/\//.test(e) && !mine.has(strip(e)) && !out.includes(strip(e))) out.push(strip(e));
    }
    return out;
  };
  return { outside };
}
