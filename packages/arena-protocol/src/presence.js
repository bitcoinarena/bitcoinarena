// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// ONLY NODES SEEN IN THE LAST 24 H ARE DRAWN (multiplayer_p2p.md §5A.3 "Absent from its seatings", protocol 22, kanban #727).
//
// Measured on testnet4 2026-10-27: every Up/Down v23 round drew 9 nodes, 7-9 of them stopped test nodes whose bonds were still locked,
// so no round was seated all day. the owner 14:00Z: "Können die adverts nur gezogen werden von nodes die in den letzten 24h auch online
// waren?" - yes, from 2.0. "Online" from pings is no shared fact, so the rule reads only signed seat messages:
//
//   window      (T - 24 h, T], T the median time past of the census block
//   a seating   one (round, role) whose seating_close (seating.js) falls in the window
//   seen        the node signed a PRESENT (drawn for it or not) or a SEATING of a seating in the window
//   absent      in the chain census, seen at no seating of the window, and drawn for one of them - or left out as absent by the
//               census a window seating was drawn from (absent stays absent until seen)
//   census      from protocol 22 the census is the chain census less every output of an absent node; its root commits to that set
//
// A node drawn for no seating in the window, and left out by no census of one, is not absent: it had nothing to be seen at (a new bond,
// a small stake, a quiet day).
//
// HOW EVERY SEAT AGREES WITHOUT HOLDING THE SAME HISTORY. No two seats hold the same PRESENTs: they are exchanged only among the 9
// drawn nodes of each seating. So the absent set is not recomputed by every seat - it is CHOSEN by the posting node, committed in the
// census root it writes into the series (fixed on chain before the beacon, so it cannot aim at a committee), and CHECKED by every
// other seat one way only: a seat refuses a census that leaves out a node it holds a window signature of, or a node it can show was
// drawn for none of the seatings the claim names. Leaving out fewer than the whole absent set is never refused - keeping a node in is
// the rule before 22. Every refutation is a signed message any seat can check, and the node itself holds its own PRESENTs, so a live
// node can always clear itself.
import { toHex } from './hash.js';
import { PRESENCE_VERSION } from './constants.js';
import { medianTimePast } from './beacon.js';

/** The window's length: 24 h of median time past before the census block (the owner 2026-10-27). */
export const PRESENCE_WINDOW_MS = 24n * 3600n * 1000n;
/** At most this many drawn seatings a claim names per absent node: one checkable is enough, three survive a seat missing a series. */
export const CLAIM_SEATINGS = 3;

/** Does this round's census leave out its absent nodes (protocol 22 on)? */
export const dropsAbsent = (contract) => !!contract && Number(contract.protocolVersion) >= PRESENCE_VERSION;

const hexOf = (k) => (typeof k === 'string' ? k.toLowerCase() : toHex(k));

/** The window of a census whose block's median time past is `censusTimeMs`: (from, to]. */
export function presenceWindow(censusTimeMs) {
  const to = BigInt(censusTimeMs);
  return { fromMs: to - PRESENCE_WINDOW_MS, toMs: to };
}
/** T: the median time past of the census block, in ms, off a view's headers - null where the view does not reach it. */
export function censusTimeMs(view, censusHeight) {
  if (!view || !Array.isArray(view.blocks)) return null;
  const t = medianTimePast(view.blocks.map((b) => b.header), view.firstHeight, censusHeight);
  return t === null ? null : BigInt(t) * 1000n;
}
export const inWindow = (w, ms) => BigInt(ms) > w.fromMs && BigInt(ms) <= w.toMs;

/**
 * THE ABSENT, AS A POSTING NODE FINDS THEM. `seatings` [{ roundId, role, closeMs, drawn: [key], seated: [key] | null }] the window's
 * seatings it can draw; `seen` the node keys it holds a window PRESENT or SEATING signature of (its own store and what it gathered);
 * `census` the chain census's node keys. A node seated by a standing certificate signed it, so it is seen. Answers the claims, by
 * node key: [{ node, drawnIn: [{ roundId, role }], from? }] sorted by key, each naming up to CLAIM_SEATINGS seatings it was drawn for.
 *
 * ABSENT STAYS ABSENT UNTIL SEEN. `carried` [{ node, root }]: the nodes the census of a window seating left out as absent, by that
 * census's root. Without it a stopped node would come back every other day: left out of one census, drawn for nothing in the next
 * census's window, so "not drawn, not punished" put it back - and on 10-27's census every second day would again draw dead nodes. Such
 * a node stays out (its claim names `from`, the root that left it out) until it is seen: a returning node signs a PRESENT for a
 * seating of the window, drawn or not, and is back from the next census.
 */
export function absentFrom({ seatings, seen, census, window, carried = [] }) {
  const inCensus = new Set([...census].map(hexOf));
  const sawIt = new Set([...seen].map(hexOf));
  const drawnIn = new Map();
  for (const s of seatings || []) {
    if (!inWindow(window, s.closeMs)) continue;
    for (const k of s.seated || []) sawIt.add(hexOf(k));
    for (const k of s.drawn || []) {
      const h = hexOf(k);
      if (!drawnIn.has(h)) drawnIn.set(h, []);
      const list = drawnIn.get(h);
      if (list.length < CLAIM_SEATINGS) list.push({ roundId: hexOf(s.roundId), role: s.role });
    }
  }
  const from = new Map();
  for (const c of carried || []) if (!from.has(hexOf(c.node))) from.set(hexOf(c.node), hexOf(c.root));
  return [...new Set([...drawnIn.keys(), ...from.keys()])].filter((h) => inCensus.has(h) && !sawIt.has(h)).sort()
    .map((node) => ({ node, drawnIn: drawnIn.get(node) || [], ...(from.has(node) ? { from: from.get(node) } : {}) }));
}

/** The census less every output of an absent node (a node is its key: all its bonds go with it). */
export function withoutAbsent(entries, absent) {
  const out = new Set((absent || []).map((a) => hexOf(a.node || a)));
  return (entries || []).filter((e) => !out.has(hexOf(e.pubkey)));
}

/**
 * THE ABSENT A COMMITTED CENSUS IMPLIES: the node keys of the chain census none of whose outputs are in the committed one. A seat
 * that holds the chain census and the round's entries (GET /census) recovers the claim's node list from the root alone.
 */
export function absentImplied(chainEntries, committedEntries) {
  const kept = new Set((committedEntries || []).map((e) => hexOf(e.pubkey)));
  return [...new Set((chainEntries || []).map((e) => hexOf(e.pubkey)))].filter((h) => !kept.has(h)).sort();
}

/**
 * A SEAT'S CHECK OF A POSTED ABSENT CLAIM - one way only. `claims` as absentFrom answers; `census` the chain census's node keys;
 * `seen` the keys this seat holds a window signature of; `drawOf(roundIdHex, role)` the drawn keys of a seating this seat can draw,
 * with its close (`{ drawn, closeMs }`), or null when it cannot (it lacks the series: a fresh seat); `carriedOf(rootHex)` the node keys
 * the claim of that census root left out, when this seat holds that claim and a window seating drawn from that census - else null.
 * Answers { ok, unchecked } or { ok: false, why, node, proof } naming the first wrong exclusion. A claim this seat cannot check is not
 * refused: it cannot prove it wrong, and a fresh seat refusing every census for a day would stop serving for nothing.
 */
export function checkAbsent(claims, { census, seen, drawOf, window, carriedOf = () => null }) {
  const inCensus = new Set([...census].map(hexOf));
  const sawIt = new Set([...seen].map(hexOf));
  const unchecked = [];
  let last = '';
  for (const c of claims || []) {
    const node = hexOf(c.node);
    if (node <= last) return { ok: false, node, why: 'that absent list is not sorted by node key, or names a node twice' };
    last = node;
    if (!inCensus.has(node)) return { ok: false, node, why: `that census leaves out ${node.slice(0, 16)} as absent, and it is not in the chain census` };
    if (sawIt.has(node)) return { ok: false, node, proof: 'seen', why: `that census leaves out ${node.slice(0, 16)} as absent, and this seat holds its signature of a seating in the 24 h` };
    const named = (c.drawnIn || []).slice(0, CLAIM_SEATINGS);
    if (!named.length && !c.from) return { ok: false, node, why: `that census leaves out ${node.slice(0, 16)} as absent and names no seating it was drawn for` };
    let checked = 0, drawn = false;
    for (const s of named) {
      const d = drawOf(hexOf(s.roundId), s.role);
      if (!d) continue;
      checked++;
      if (inWindow(window, d.closeMs) && d.drawn.some((k) => hexOf(k) === node)) { drawn = true; break; }
    }
    // carried from the census of a window seating that left it out already
    if (!drawn && c.from) {
      const was = carriedOf(hexOf(c.from));
      if (was) { checked++; if (was.some((k) => hexOf(k) === node)) drawn = true; }
    }
    if (checked && !drawn) return { ok: false, node, proof: 'not-drawn', why: `that census leaves out ${node.slice(0, 16)} as absent, and none of the seatings it names drew it in the 24 h, nor did the census it names leave it out` };
    if (!checked) unchecked.push(node);
  }
  return { ok: true, unchecked };
}
