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
// as before - asked too once any host has several URLs, so a relayed proof meets the seat's own (kanban #3730, below). A seat with several
// URLs is asked at each, and its answers count as one vote - none when they disagree (seatVoice).
//
// What this cannot stop: one box under several HOSTNAMES (evil0.example, evil1.example, ...: wildcard DNS) that answer no identity is still
// one seat per hostname. Where the answers a door counts carry their own signatures (a lock-set certificate, a signed fee proposal) the door
// checks those instead; where they do not, the most a door can do is keep those seats from outnumbering the round's proven ones.
import { taggedHash, toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { identityBoundDigest, identityHostKey, bindsIdentity } from '../../arena-protocol/src/identity-proof.js';   // kanban #3800
import { sourceKey } from './join.js';
import { endpointRoot } from './node-discovery.js';

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

// A PROOF BOUND TO THE ADDRESS ASKED (kanban #3800, RULED 2026-11-26, protocol 34): the seat signs, beside the nonce, the Host it was asked
// at (`at`, `atSig`: arena-protocol identity-proof.js). With `bound` (a round of 34+, bindsIdentity) a URL proves a key only where `at` is
// the URL's own host, or the host the page's alt route for it reaches (window.ARENA_VIA_ALT: the page's own routes, never the link's) - a
// box that relays a seat's /identity gets the seat's host signed, not its own, so its path proves nothing. Without it: today's rule.
const askedHosts = (base) => {
  const out = new Set();
  const add = (u) => { try { const h = identityHostKey(new URL(String(u)).host); if (h) out.add(h); } catch { /* not a URL */ } };
  add(base);
  const via = typeof globalThis.ARENA_VIA_ALT === 'function' ? globalThis.ARENA_VIA_ALT : null;
  if (via) { try { add(via(String(base))); } catch { /* no route */ } }
  return out;
};

/**
 * The node key the seat at `base` proves over a fresh nonce (64 hex, lower case), or null. `verify(sig, msg, key)`: BIP-340. `bound`: only a
 * proof bound to the host asked counts (kanban #3800).
 */
export async function provenKeyAt(base, { fetcher = fetch, verify, ms = 8000, now = Date.now(), bound = false } = {}) {
  base = seatUrlTrimmed(base);
  const keptAs = `${bound ? 'bound' : 'any'} ${base}`;   // a key proven unbound never stands for a bound ask
  const kept = PROVEN_KEYS.get(keptAs);
  if (kept && now - kept.at < PROOF_KEEP_MS) return kept.key;
  if (typeof verify !== 'function') return null;
  try {
    const nonce = proofNonce();
    const r = await fetcher(`${base}/identity?nonce=${toHex(nonce)}`, { signal: AbortSignal.timeout(ms) });
    if (!r || !r.ok) return null;
    const j = JSON.parse(await r.text());
    const key = j && typeof j.node === 'string' ? j.node.toLowerCase() : '';
    if (!/^[0-9a-f]{64}$/.test(key) || !/^[0-9a-f]{128}$/i.test(String(j.sig))) return null;
    if (bound) {
      const at = typeof j.at === 'string' ? identityHostKey(j.at) : '';
      if (!at || !askedHosts(base).has(at) || !/^[0-9a-f]{128}$/i.test(String(j.atSig))) return null;
      if (!verify(fromHex(String(j.atSig).toLowerCase()), identityBoundDigest(nonce, at), fromHex(key))) return null;
    } else if (!verify(fromHex(String(j.sig).toLowerCase()), identityProofDigest(nonce), fromHex(key))) return null;
    if (PROVEN_KEYS.size >= PROVEN_KEYS_MAX) PROVEN_KEYS.delete(PROVEN_KEYS.keys().next().value);
    PROVEN_KEYS.set(keptAs, { key, at: now });
    return key;
  } catch { return null; }
}

// A PROOF IS A KEY'S, NOT AN ADDRESS'S (kanban #3730, audit client-a8-1-1, the gap in #3574): the signed digest names only the nonce, so a
// box that passes GET /identity?nonce= on to a round seat's public door hands back that seat's real signature, and its own path "proves" the
// seat's key. One box under three paths relaying to three seats was three proven seats, and its unsigned settlement outvoted the honest two -
// while the honest seats, alone on their hosts, were never asked, so nothing saw the same key proven twice. The digest stays as it is (the
// node side's #3585 ruling: GET /identity and its digest are unchanged); what changes is where a proof is believed:
// - once any host of the list has several URLs (proofs are asked at all), EVERY URL is asked, so a relayed key meets the seat's own URL and
//   the two are one seat: one key, one seat, whatever the hosts;
// - where the key's census advert names an address and one of the URLs proving the key IS that address (as named, or through the page's
//   alt routes, window.ARENA_VIA_ALT: the live seats advertise one host and are reached at another), only that URL keeps the key - a relaying
//   path proves nothing and stays in its host's one seat, and the seat keeps its voice (#3585's rule, page side);
// - otherwise a key proven at several URLs is one seat whose URLs must agree (seatVoice): a relay can stall that seat's vote, not cast it.
// A box relaying a round seat the link does not name at all still proves that key - one more voice, as one more hostname of the box would
// be (the limit stated above) - in a round below 34. From 34 (kanban #3800) the proof is bound to the host asked (`bound`, above), and the
// relayed proof names the seat's host, not the box's.
/** A seat URL as adverts and links are compared: scheme and host lower case, no trailing slash. */
export const seatUrlKey = (u) => {
  try { const x = new URL(String(u)); return `${x.protocol}//${x.host.toLowerCase().replace(/\.+$/, '')}${x.pathname.replace(/\/+$/, '')}`; } catch { return seatUrlTrimmed(u); }
};
// THE ADDRESSES THE CHECKED CENSUSES' ADVERTS NAME (kanban #3730): committee.js notes each census this page checked (noteAdverts), and
// seatsOf reads them unless the caller names its own
const ADVERTS = new Map(), ADVERT_KEYS_MAX = 5000;
/** Note the advert endpoints of a checked census's entries ([{ pubkey, advert: { endpoint } }]) for seatsOf. */
export function noteAdverts(entries) {
  for (const e of entries || []) {
    let k = null, root = null;
    try { k = e && e.pubkey ? seatKeyHex(e.pubkey) : null; root = e && e.advert && e.advert.endpoint ? endpointRoot(e.advert.endpoint) : null; } catch { k = null; }
    if (!k || !/^[0-9a-f]{64}$/.test(k) || !root) continue;
    if (!ADVERTS.has(k)) { if (ADVERTS.size >= ADVERT_KEYS_MAX) ADVERTS.delete(ADVERTS.keys().next().value); ADVERTS.set(k, new Set()); }
    ADVERTS.get(k).add(root);
  }
}
export const forgetAdverts = () => ADVERTS.clear();
const advertLookup = (advertised) => {
  if (advertised === undefined) return (k) => ADVERTS.get(k) || null;
  if (!advertised) return () => null;
  if (typeof advertised === 'function') return (k) => advertised(k);
  const m = advertised instanceof Map ? advertised : new Map(Object.entries(advertised));
  const byKey = new Map();
  for (const [k, v] of m) byKey.set(seatKeyHex(k), v);
  return (k) => byKey.get(k) || null;
};
// an advert's address as the page reaches it: as named, and through the page's alt routes where it has them
const advertKeys = (roots) => {
  const out = new Set();
  const via = typeof globalThis.ARENA_VIA_ALT === 'function' ? globalThis.ARENA_VIA_ALT : null;
  for (const r of roots || []) { out.add(seatUrlKey(r)); if (via) { try { out.add(seatUrlKey(via(String(r)))); } catch { /* no route */ } } }
  return out;
};

/**
 * THE SEATS BEHIND A NODE LIST: [{ id, urls, key }] in the list's order. `keys`: the round's node keys (bytes or hex) - a host's URL is a
 * seat of its own only when it proves one of them (and no other URL proved the same key: those are one seat). `verify`: BIP-340
 * (the page's curve.verify). `advertised`: the addresses the census adverts name per key (key hex -> URLs; a Map, an object or a function;
 * by default the adverts of the censuses this page checked, noteAdverts; null for none) - where one of a key's URLs is its advert's, the
 * key is that URL's alone (kanban #3730). Without keys or verify every host is one seat.
 */
// `bound` (kanban #3800): a round of 34+ (bindsIdentity) - a URL proves a key only with a proof bound to its host.
export async function seatsOf(nodes, { keys = [], verify = null, fetcher = fetch, ms = 8000, advertised, bound = false } = {}) {
  const want = new Set((keys || []).map(seatKeyHex).filter(Boolean));
  const sources = distinctSources(nodes);
  const order = new Map(sources.map((u, i) => [u, i]));
  const byHost = new Map();
  for (const u of sources) { const h = hostOf(u); if (!byHost.has(h)) byHost.set(h, []); byHost.get(h).push(u); }
  // proofs are asked only where some host has several URLs - and then of every URL (kanban #3730)
  const asking = want.size > 0 && typeof verify === 'function' && [...byHost.values()].some((us) => us.length > 1);
  const seats = [];
  if (!asking) {
    for (const [host, urls] of byHost) seats.push({ id: `host:${host}`, urls, key: null });
  } else {
    const proven = await Promise.all(sources.map((u) => provenKeyAt(u, { fetcher, verify, ms, bound })));
    const byKey = new Map();
    sources.forEach((u, i) => { const k = proven[i]; if (k && want.has(k)) { if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(u); } });
    const advertOf = advertLookup(advertised);
    const keyed = new Set();
    for (const [k, us] of byKey) {
      let roots = null;
      try { roots = advertOf(k); } catch { roots = null; }
      const named = roots ? advertKeys([...roots]) : null;
      const own = named && us.length > 1 ? us.filter((u) => named.has(seatUrlKey(u))) : [];
      const keep = own.length ? own : us;
      seats.push({ id: `key:${k}`, urls: keep, key: k });
      for (const u of keep) keyed.add(u);
    }
    for (const [host, urls] of byHost) { const rest = urls.filter((u) => !keyed.has(u)); if (rest.length) seats.push({ id: `host:${host}`, urls: rest, key: null }); }
  }
  const first = (s) => Math.min(...s.urls.map((u) => order.get(u)));
  return seats.map((s) => ({ ...s, urls: [...s.urls].sort((x, y) => order.get(x) - order.get(y)) }))
    .sort((x, y) => first(x) - first(y)).map(({ id, urls, key }) => ({ id, urls, key }));
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
