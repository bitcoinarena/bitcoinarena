// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A URL SOMEONE ELSE NAMED IS ASKED ON THE PUBLIC INTERNET ONLY (kanban #1511, #1689, #1746, #1884, #1919, #1962).
// A Lightning address, an LNURL, a payout address or a seat endpoint a bonded node announced can name any URL - 127.0.0.1:<port>, 169.254.169.254,
// a LAN host - and the asker echoes what it answers. Moved here from feedback-store.js (#1511) so that every asker uses the same guard: the
// faucet's wallet asks (feedback-store.js), its node bounty check of announced seat endpoints (tools/faucet.mjs, #1884), and every seat's payout
// LNURL asks (winnings-send.js, reserve-payout.js, server.js, #1919).
//  - the name: no IP literal (or, where an IP literal is taken, a public one only), localhost or local-only name (urlRefusal);
//  - the ADDRESS the name resolves to: no loopback, private, link-local, CGNAT, unique-local, multicast or unspecified address - checked in the
//    connection's own lookup (guardedLookup), so the socket goes to exactly the address that was checked and a name cannot re-resolve in between;
//  - a REDIRECT is followed by hand only (#1962: a Lightning address on one's own domain usually answers 301 to its wallet provider), at most
//    REDIRECTS_MOST hops, and each Location is checked exactly as the first URL was - name here, resolved address in the connection's lookup
//    (#1746: a public host's 302 to an internal URL is never fetched).
import { lookup as dnsLookup } from 'node:dns';
import { isIP, BlockList } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';

const INTERNAL = new BlockList();
for (const [a, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]) INTERNAL.addSubnet(a, p, 'ipv4');
for (const [a, p] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8], ['100::', 64], ['2001:db8::', 32]]) INTERNAL.addSubnet(a, p, 'ipv6');
export function internalAddress(ip) {
  const a = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const v = isIP(a);
  if (v === 4) return INTERNAL.check(a, 'ipv4');
  if (v !== 6) return true;
  // an IPv4 address carried in IPv6 (mapped ::ffff:, compatible ::, NAT64 64:ff9b::, 6to4 2002:) is judged as that IPv4 address
  const words = expand6(a); if (!words) return true;
  const v4 = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  if (words.slice(0, 5).every((w) => w === 0) && (words[5] === 0xffff || words[5] === 0)) return words[5] === 0 && words[6] === 0 && words[7] <= 1 ? true : internalAddress(v4(words[6], words[7]));
  if (words[0] === 0x64 && words[1] === 0xff9b && words.slice(2, 6).every((w) => w === 0)) return internalAddress(v4(words[6], words[7]));
  if (words[0] === 0x2002) return internalAddress(v4(words[1], words[2]));
  return INTERNAL.check(a, 'ipv6');
}
function expand6(a) {
  let s = a;
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) { const o = dotted[1].split('.').map(Number); s = s.slice(0, -dotted[1].length) + ((o[0] << 8) | o[1]).toString(16) + ':' + ((o[2] << 8) | o[3]).toString(16); }
  const [head, tail] = s.includes('::') ? s.split('::') : [s, null];
  const h = head ? head.split(':') : [], t = tail ? tail.split(':') : [];
  const fill = tail === null ? [] : new Array(8 - h.length - t.length).fill('0');
  const all = [...h, ...fill, ...t];
  if (all.length !== 8) return null;
  const n = all.map((x) => parseInt(x || '0', 16));
  return n.some((x) => !Number.isFinite(x) || x < 0 || x > 0xffff) ? null : n;
}
const LOCAL_NAME = /(^|\.)(localhost|local|internal|lan|home|arpa|localdomain|intranet|home\.arpa|onion)$/;
/**
 * Why `url` is not asked, or null. `http`: plain http is taken too (a seat endpoint); otherwise https only (a wallet). `ipLiteral`: a PUBLIC IP
 * literal is taken (a seat on a bare address); otherwise a name only. A local-only name (localhost, .local, .internal, .onion ...) never.
 */
export function urlRefusal(url, { http = false, ipLiteral = false } = {}) {
  let u; try { u = new URL(String(url)); } catch { return 'that is not a URL'; }
  if (u.protocol !== 'https:' && !(http && u.protocol === 'http:')) return http ? 'it must be on http or https' : 'its wallet must be on https';
  if (u.username || u.password) return 'its wallet must be on a public name';
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const literal = isIP(host) || /^\d+(\.\d+){3}$|^\d+$|^0x/i.test(host);
  if (literal) return ipLiteral && isIP(host) && !internalAddress(host) ? null : 'its wallet must be on a public name';
  if (!host || !host.includes('.') || LOCAL_NAME.test(host)) return 'its wallet must be on a public name';
  return null;
}
// the wallet URL's own name: https only, a public-looking name (an IP literal or a local-only name is refused before any lookup)
export const walletUrlRefusal = (url) => urlRefusal(url);
// the connection's lookup: every address the name resolves to must be public, or the connection is refused (EINTERNALHOST)
export function guardedLookup(hostname, options, cb) {
  if (typeof options === 'function') { cb = options; options = {}; }
  const o = typeof options === 'number' ? { family: options } : { ...(options || {}) };
  dnsLookup(hostname, { ...o, all: true }, (err, list) => {
    if (err) return cb(err);
    const bad = (list || []).find((x) => internalAddress(x.address));
    if (!list || !list.length || bad) { const e = new Error(`${hostname} resolves to an internal address`); e.code = 'EINTERNALHOST'; return cb(e); }
    if (o.all) return cb(null, list);
    cb(null, list[0].address, list[0].family);
  });
}
const refusedError = (why) => Object.assign(new Error(why), { code: 'EINTERNALHOST' });
// ONE GET to a public address only, NEVER following a redirect itself (a 3xx comes back as it is, its Location in headers), at most BODY_MOST
// bytes; answers { ok, status, headers.get, json(), text() } like fetch. `http` / `ipLiteral` as urlRefusal.
const BODY_MOST = 256 * 1024;
export function publicFetch(url, { signal, headers, http = false, ipLiteral = false } = {}) {
  return new Promise((resolve, reject) => {
    const refused = urlRefusal(url, { http, ipLiteral });
    if (refused) return reject(refusedError(refused));
    const request = new URL(String(url)).protocol === 'http:' ? httpRequest : httpsRequest;
    const req = request(String(url), { method: 'GET', headers: headers || {}, lookup: guardedLookup, signal, agent: false }, (res) => {
      const chunks = []; let n = 0;
      res.on('data', (c) => { n += c.length; if (n > BODY_MOST) { res.destroy(new Error('its answer is too large')); return; } chunks.push(c); });
      res.on('error', reject);
      res.on('end', () => { const body = Buffer.concat(chunks).toString('utf8'); const status = res.statusCode || 0;
        const get = (k) => { const v = res.headers[String(k).toLowerCase()]; return v === undefined ? null : Array.isArray(v) ? v.join(', ') : String(v); };
        resolve({ ok: status >= 200 && status < 300, status, headers: { get }, json: async () => JSON.parse(body), text: async () => body }); });
    });
    req.on('error', reject);
    req.end();
  });
}
/** At most this many redirects are followed (kanban #1962), each one checked as the first URL. */
export const REDIRECTS_MOST = 3;
const REDIRECT = new Set([301, 302, 303, 307, 308]);
/**
 * A GET that follows redirects BY HAND (kanban #1962): every URL - the first and each Location - must pass `refusal` before it is asked, and is
 * asked with `fetchFn(url, { signal, headers, redirect: 'manual' })` (publicFetch by default: the resolved address checked too). After
 * `redirects` hops the last 3xx is answered as it is. A refused URL throws with code EINTERNALHOST.
 */
export async function checkedFetch(url, { fetchFn = publicFetch, signal, headers, redirects = REDIRECTS_MOST, refusal = walletUrlRefusal } = {}) {
  let u = String(url);
  for (let hop = 0; ; hop++) {
    const refused = refusal(u); if (refused) throw refusedError(refused);
    const r = await fetchFn(u, { signal, headers, redirect: 'manual' });
    const to = r && REDIRECT.has(r.status) && r.headers && typeof r.headers.get === 'function' ? r.headers.get('location') : null;
    if (!to || hop >= redirects) return r;
    try { u = new URL(to, u).toString(); } catch { throw refusedError('its wallet redirected to no URL'); }
  }
}

/**
 * A SEAT'S DEFAULT FETCH FOR A PLAYER'S PAYOUT ADDRESS (kanban #1919): the LNURL / Lightning address endpoint and its callback, as fetch(u, o)
 * answers. https on a public name and address only, redirects checked hop by hop; a .onion host over http only (LUD-16: a Tor host holds no
 * certificate), which goes to the process's own fetch - a Tor route is the operator's - and is never redirected.
 */
export function lnurlPublicFetch(url, o = {}) {
  let host = ''; try { host = new URL(String(url)).hostname.toLowerCase(); } catch { /* refused below */ }
  if (/\.onion$/.test(host)) return fetch(String(url), { ...o, redirect: 'error' });
  return checkedFetch(url, { signal: o.signal, headers: o.headers });
}

/**
 * A SEAT ENDPOINT SOMEONE ANNOUNCED (kanban #1884): http or https, a public name or a public IP literal, the resolved address public, no
 * redirect at all (a seat's doors need none).
 */
export const seatUrlRefusal = (url) => urlRefusal(url, { http: true, ipLiteral: true });
export function seatPublicFetch(url, o = {}) {
  return checkedFetch(url, { fetchFn: (u, x) => publicFetch(u, { ...x, http: true, ipLiteral: true }), signal: o.signal, headers: o.headers, redirects: 0, refusal: seatUrlRefusal });
}
