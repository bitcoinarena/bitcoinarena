// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A NODE SAYS WHERE IT IS NOW, OFF CHAIN (kanban #562, 2026-10-21 ~07:35Z: "1 default, 2 for updates so no needed updates").
// A node's census entry names its endpoint, committed in its bond's advertisement (§25: "A committed endpoint cannot change cheaply").
// The default is an address that does not change - a named tunnel or the operator's own domain. When it does change (a quick
// tunnel's new name after a restart), the node signs an ADDRESS ANNOUNCEMENT with its node key - its endpoint now and when it said
// so - and hands it to the seats. Whoever looks for the node (a seat, another guardian's P2P tunnel, the founding's code exchange)
// takes the newest valid announcement of a census node over its census endpoint. No transaction, no fee, no wait for confirmations;
// the census entry stays the node's identity and its bond, only the address moves.
//
//   { node, endpoint, atMs, sig }   node: hex x-only key (the census entry's), endpoint: http(s)/ws(s) URL, atMs: ms since 1970,
//                                   sig: BIP-340 over H_tag(node || endpoint || atMs)
import { Writer } from './encode.js';
import { taggedHash, fromHex, toHex } from './hash.js';

export const ADDRESS_ANNOUNCEMENT_TAG = 'BLWP/v1/ADDRESS_ANNOUNCEMENT';
/** An announcement dated further ahead than this is refused (a clock far ahead would win every comparison). */
export const ADDRESS_FUTURE_MS = 10 * 60 * 1000;

const hexOf = (k) => (typeof k === 'string' ? k : toHex(k)).toLowerCase();
const isEndpoint = (u) => { try { return ['http:', 'https:', 'ws:', 'wss:'].includes(new URL(String(u)).protocol); } catch { return false; } };

/** The 32 bytes an announcement's signature covers. */
export function addressAnnouncementHash({ node, endpoint, atMs }) {
  const w = new Writer();
  w.bytes32(fromHex(hexOf(node))); w.str(String(endpoint)); w.u64(BigInt(atMs));
  return taggedHash(ADDRESS_ANNOUNCEMENT_TAG, w.finish());
}

/** Sign one: `sign(digest)` with the node key. */
export function signAddressAnnouncement({ node, endpoint, atMs }, sign) {
  if (!isEndpoint(endpoint)) throw new Error(`an address announcement names an http(s) or ws(s) endpoint, not ${endpoint}`);
  const a = { node: hexOf(node), endpoint: String(endpoint), atMs: Number(atMs) };
  return { ...a, sig: toHex(sign(addressAnnouncementHash(a))) };
}

/** Check one: its shape, its date, its signature by the node it names. Answers { ok, why }. */
export function checkAddressAnnouncement(a, { verify, nowMs = Date.now() }) {
  if (!a || typeof a !== 'object') return { ok: false, why: 'not an announcement' };
  if (!/^[0-9a-f]{64}$/.test(String(a.node || ''))) return { ok: false, why: 'no node key' };
  if (!isEndpoint(a.endpoint)) return { ok: false, why: 'no http(s) or ws(s) endpoint' };
  if (!Number.isSafeInteger(a.atMs) || a.atMs <= 0) return { ok: false, why: 'no date' };
  if (a.atMs > nowMs + ADDRESS_FUTURE_MS) return { ok: false, why: 'dated in the future' };
  if (!/^[0-9a-f]{128}$/.test(String(a.sig || ''))) return { ok: false, why: 'no signature' };
  let good = false;
  try { good = verify(fromHex(a.sig), addressAnnouncementHash(a), fromHex(a.node)); } catch { good = false; }
  return good ? { ok: true } : { ok: false, why: 'the signature is not the node\'s' };
}

/** Of two announcements of one node, the one that stands: the later date (the first one kept on a tie). */
export const newerAnnouncement = (have, got) => (!have || got.atMs > have.atMs ? got : have);

/**
 * WHERE A CENSUS NODE IS: its newest valid announcement's endpoint, else its census endpoint. `announced` a Map node hex -> the
 * announcement that stands (already checked). An announcement older than the advertisement it would override does not override it.
 */
export function endpointOf(entry, announced) {
  const census = entry && entry.advert ? entry.advert.endpoint || null : null;
  const a = announced && entry ? announced.get(hexOf(entry.pubkey)) : null;
  if (!a) return census;
  const advertMs = entry.advert && entry.advert.timestamp !== undefined ? Number(entry.advert.timestamp) : 0;
  return a.atMs >= advertMs ? a.endpoint : census;
}
