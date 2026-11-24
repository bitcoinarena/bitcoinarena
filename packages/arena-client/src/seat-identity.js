// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// ONE SEAT, ONE VOTE, HOWEVER MANY URLS A LINK GIVES IT (kanban #3574, audit client-a7-1-1, the gap in #3350).
//
// A join or lobby link's node= list is the link author's: one box named under several paths (http://liar.test/a, /b, /c) was several
// "seats", and its unsigned answers outvoted the round's real ones. Counting by host alone is wrong the other way: the live seats share one
// public host and differ by path (https://h/guardian-1 .. /guardian-7), and one vote per host would make seven seats one.
//
// So a host's URLs are separate seats only when each of them PROVES a distinct node key of the round's key set: GET /identity?nonce=<fresh>
// answers the seat's BIP-340 signature over identityProofDigest(nonce) (arena-node server.js, kanban #2982/#3253) - a box cannot sign for a
// key it does not hold, and the fresh nonce keeps it from replaying another seat's answer. Every URL of a host that proves no key of the set
// (no answer, a bad signature, a key the round did not draw) is that host's one seat together. A URL alone on its host is a seat by itself,
// as before (nothing is asked of it). A seat with several URLs is asked at each, and its answers count as one vote - none when they disagree
// (seatVoice).
//
// What this cannot stop: one box under several HOSTNAMES (evil0.example, evil1.example, ...: wildcard DNS) that answer no identity is still
// one seat per hostname. Where the answers a door counts carry their own signatures (a lock-set certificate, a signed fee proposal) the door
// checks those instead; where they do not, the most a door can do is keep those seats from outnumbering the round's proven ones.
import { taggedHash, toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { sourceKey } from './join.js';

/** The digest a seat signs at GET /identity?nonce= (the same as arena-node's identityProofDigest). */
export const identityProofDigest = (nonce) => taggedHash('ARENA/v1/NodeIdentityProof', nonce);

const seatUrlTrimmed = (u) => String(u).replace(/\/+$/, '');
/** A URL's host as seats are grouped by it: its hostname, lower case, without a trailing dot (ports and paths of one box are one host). */
export const hostOf = (u) => {
  try { const x = new URL(String(u)); if (x.hostname) return x.hostname.toLowerCase().replace(/\.+$/, ''); } catch { /* not a URL */ }
  return seatUrlTrimmed(u);
};
/** The node list with each source once (origin + first path segment, join.js sourceKey; the first spelling kept) - the #3350 step. */
export const distinctSources = (nodes) => {
  const seen = new Set(), out = [];
  for (const n of nodes || []) { const k = sourceKey(String(n)) || seatUrlTrimmed(n); if (!seen.has(k)) { seen.add(k); out.push(n); } }
  return out;
};
const seatKeyHex = (k) => { try { return (typeof k === 'string' ? k : toHex(k)).toLowerCase(); } catch { return ''; } };

// A PROVEN KEY IS KEPT A WHILE (the IDENTITY_KEEP_MS of join.js: a seat's key does not change behind its URL, and a page asks often); only
// a proof is kept - a URL that proved nothing is asked again the next time
export const PROOF_KEEP_MS = 300000;
const PROVEN_KEYS = new Map(), PROVEN_KEYS_MAX = 2000;
export const forgetProofs = () => PROVEN_KEYS.clear();
const proofNonce = () => { const n = new Uint8Array(32); globalThis.crypto.getRandomValues(n); return n; };

/** The node key the seat at `base` proves over a fresh nonce (64 hex, lower case), or null. `verify(sig, msg, key)`: BIP-340. */
export async function provenKeyAt(base, { fetcher = fetch, verify, ms = 8000, now = Date.now() } = {}) {
  base = seatUrlTrimmed(base);
  const kept = PROVEN_KEYS.get(base);
  if (kept && now - kept.at < PROOF_KEEP_MS) return kept.key;
  if (typeof verify !== 'function') return null;
  try {
    const nonce = proofNonce();
    const r = await fetcher(`${base}/identity?nonce=${toHex(nonce)}`, { signal: AbortSignal.timeout(ms) });
    if (!r || !r.ok) return null;
    const j = JSON.parse(await r.text());
    const key = j && typeof j.node === 'string' ? j.node.toLowerCase() : '';
    if (!/^[0-9a-f]{64}$/.test(key) || !/^[0-9a-f]{128}$/i.test(String(j.sig))) return null;
    if (!verify(fromHex(String(j.sig).toLowerCase()), identityProofDigest(nonce), fromHex(key))) return null;
    if (PROVEN_KEYS.size >= PROVEN_KEYS_MAX) PROVEN_KEYS.delete(PROVEN_KEYS.keys().next().value);
    PROVEN_KEYS.set(base, { key, at: now });
    return key;
  } catch { return null; }
}

/**
 * THE SEATS BEHIND A NODE LIST: [{ id, urls, key }] in the list's order. `keys`: the round's node keys (bytes or hex) - a host's URL is a
 * seat of its own only when it proves one of them (and no other URL proved the same key: those are one seat). `verify`: BIP-340
 * (the page's curve.verify). Without keys or verify every host is one seat.
 */
export async function seatsOf(nodes, { keys = [], verify = null, fetcher = fetch, ms = 8000 } = {}) {
  const want = new Set((keys || []).map(seatKeyHex).filter(Boolean));
  const byHost = new Map();
  for (const u of distinctSources(nodes)) { const h = hostOf(u); if (!byHost.has(h)) byHost.set(h, []); byHost.get(h).push(u); }
  const seats = [];
  await Promise.all([...byHost.entries()].map(async ([host, urls]) => {
    if (urls.length === 1 || !want.size || typeof verify !== 'function') { seats.push({ id: `host:${host}`, urls, key: null, at: urls[0] }); return; }
    const proven = await Promise.all(urls.map((u) => provenKeyAt(u, { fetcher, verify, ms })));
    const byKey = new Map(), rest = [];
    urls.forEach((u, i) => {
      const k = proven[i];
      if (k && want.has(k)) { if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(u); } else rest.push(u);
    });
    for (const [k, us] of byKey) seats.push({ id: `key:${k}`, urls: us, key: k, at: us[0] });
    if (rest.length) seats.push({ id: `host:${host}`, urls: rest, key: null, at: rest[0] });
  }));
  // one key proven on two hosts is one seat (a seat reached at two names)
  const merged = new Map();
  for (const s of seats) {
    const m = merged.get(s.id);
    if (m) m.urls.push(...s.urls); else merged.set(s.id, { ...s, urls: [...s.urls] });
  }
  const order = new Map(distinctSources(nodes).map((u, i) => [u, i]));
  return [...merged.values()].sort((a, b) => order.get(a.at) - order.get(b.at)).map(({ id, urls, key }) => ({ id, urls, key }));
}

/**
 * ONE SEAT'S VOICE: its URLs' answers as one vote. `answers` are the answers of the seat's URLs; `keyOf(a)` what an answer says, or null
 * for no answer (a refusal, a timeout). The first answer when every answer that said something says the same, else null - a seat whose
 * URLs disagree has no vote.
 */
export function seatVoice(answers, keyOf) {
  let first = null, k0 = null;
  for (const a of answers || []) {
    const k = keyOf(a);
    if (k === null || k === undefined) continue;
    if (first === null) { first = a; k0 = k; } else if (k !== k0) return null;
  }
  return first;
}
