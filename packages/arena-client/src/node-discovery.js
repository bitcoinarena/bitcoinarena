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

// AN ENDPOINT THE SEATS REFUSE IS NOT LEARNED BY THE PAGE EITHER (kanban #3107, #3108; wf1489 refute of #3082/#2856): a bond's advert
// endpoint is the bond holder's choice. The seats dial one only where peerEndpointRefusal (arena-node address-book.js) takes it, but the
// page took every one raw, kept it in localStorage (arena.nodes.*) and asked it again at every start - one bond committing
// 'http://127.0.0.1:18777/lnurlp/tips/cb?amount=1000&x=' or 'http://192.168.1.1/admin' made every player's browser send GET <that>/games
// ... to its own machine or LAN, the query swallowing the door. The same rule here, in the page's own words: an http(s)/ws(s) origin with
// at most one path segment, no query, fragment or user info, and never a loopback / private / link-local / ULA literal or a local-only name
// - unless the page itself is served from a local host (a devnet), where its nodes are local too.
const ND_LOCAL_NAME = /(^|\.)(localhost|local|internal|lan|intranet|localdomain|home\.arpa)$/;
// ONE RULE FOR THE SEAT, THE PAGE AND PUBLIC-FETCH (kanban #3124, #3125; wf1489 refute of #3107/#3108): the seat's peerEndpointRefusal
// (arena-node address-book.js) refused IP literals and localhost only, so a bond committing 'http://127.0.0.1.nip.io:18777/lnurlp',
// 'http://localtest.me:18777/lnurlp' or 'http://host.docker.internal:18777/x' was dialed by every seat on its own loopback or LAN. The
// names below lead back to an address spelled inside them (public wildcard DNS made for exactly that), and a name carrying an internal
// IPv4 address in dots or dashes ('10-0-0-1.example', '192.168.1.1.anything') is refused too. The seat and public-fetch now call this
// function, so the copies cannot drift. NOT *.ts.net: live seats announce their tailnet names (public-fetch refuses them on its own).
const ND_REBIND_NAME = /(^|\.)(nip\.io|sslip\.io|xip\.io|traefik\.me|localtest\.me|lvh\.me|vcap\.me|localhost\.direct|rbndr\.us|1u\.ms|localho\.st|local\.gd)$/;   // the last four: more public rebinding names
function ndEmbeddedInternalV4(h) {
  const parts = h.split(/[.-]/);
  for (let i = 0; i + 4 <= parts.length; i++) {
    const q = parts.slice(i, i + 4);
    if (q.every((x) => /^\d{1,3}$/.test(x) && Number(x) <= 255) && ndInternalV4(q.map(Number).join('.'))) return true;
  }
  return false;
}
function ndInternalV4(h) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const [a, b, c] = m.slice(1, 4).map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b < 32)
    || (a === 192 && b === 168) || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113);
}
function ndInternalV6(h) {
  const [head, tail] = h.includes('::') ? h.split('::') : [h, null];
  const hs = head ? head.split(':') : [], ts = tail ? tail.split(':') : [];
  const all = [...hs, ...(tail === null ? [] : new Array(Math.max(0, 8 - hs.length - ts.length)).fill('0')), ...ts];
  if (all.length !== 8) return true;
  const w = all.map((x) => parseInt(x || '0', 16));
  if (w.some((x) => !Number.isFinite(x) || x < 0 || x > 0xffff)) return true;
  const v4 = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  if (w.slice(0, 5).every((x) => x === 0) && (w[5] === 0xffff || w[5] === 0)) return (w[5] === 0 && w[6] === 0 && w[7] <= 1) || ndInternalV4(v4(w[6], w[7]));
  if (w[0] === 0x64 && w[1] === 0xff9b && w.slice(2, 6).every((x) => x === 0)) return ndInternalV4(v4(w[6], w[7]));
  if (w[0] === 0x2002) return ndInternalV4(v4(w[1], w[2]));
  return (w[0] & 0xfe00) === 0xfc00 || (w[0] & 0xffc0) === 0xfe80 || (w[0] & 0xffc0) === 0xfec0 || (w[0] & 0xff00) === 0xff00
    || (w[0] === 0x100 && w[1] === 0 && w[2] === 0 && w[3] === 0) || (w[0] === 0x2001 && w[1] === 0xdb8);
}
/** True for a loopback / private / link-local / ULA literal, a local-only name (localhost, *.local, *.lan, a bare single label ...), a name made to
 * resolve to the address it spells (*.nip.io, localtest.me ...) or one carrying an internal IPv4 address (kanban #3124). */
export function localHostName(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '').replace(/\.$/, '');
  if (!h) return true;
  if (h.includes(':')) return ndInternalV6(h);
  if (/^[\d.]+$|^0x/i.test(h)) return !/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || ndInternalV4(h);
  return !h.includes('.') || ND_LOCAL_NAME.test(h) || ND_REBIND_NAME.test(h) || ndEmbeddedInternalV4(h);   // kanban #3124
}
/**
 * Why the page does not ask `endpoint` as a node, or null - the seats' peerEndpointRefusal, page side (kanban #3107, #3108). `localOk`:
 * the page itself is served from a local host (a devnet; the page passes localHostName(its own hostname) - no file here reads the page).
 */
export function nodeEndpointRefusal(endpoint, { localOk = false } = {}) {
  const s = String(endpoint || '');
  let u; try { u = new URL(s); } catch { return 'not a URL'; }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol)) return 'not an http(s) or ws(s) endpoint';
  if (u.username || u.password) return 'an endpoint carries no user info';
  if (u.search || u.hash || s.includes('?') || s.includes('#')) return 'an endpoint carries no query or fragment';
  if (u.pathname.replace(/\/+$/, '').split('/').filter(Boolean).length > 1) return 'an endpoint is an origin with at most one path segment';
  if (!localOk && localHostName(u.hostname)) return 'an endpoint on a loopback or private address';
  return null;
}
/** The node roots a page kept from an earlier start, without those it must not ask (lists kept before kanban #3107/#3108 are cleaned). */
export function keptNodes(kept, opts = {}) {
  return (Array.isArray(kept) ? kept : []).filter((n) => typeof n === 'string' && !nodeEndpointRefusal(n, opts));
}

/** Every node a checked census names, by its advertised endpoint: one root per node key, in the order of their keys. */
export function censusEndpoints(entries, opts = {}) {
  const byKey = new Map();
  for (const e of entries || []) {
    const at = e && e.advert && e.advert.endpoint;
    if (!at || nodeEndpointRefusal(at, opts)) continue;   // kanban #3107, #3108
    const root = endpointRoot(at);
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
