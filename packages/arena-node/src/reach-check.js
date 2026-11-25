// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// CAN THE INTERNET REACH A NEW NODE? (ruling 7, 2026-10-18: "the installer automatically detects if outside
// connections are possible and if firewalls block it"). Only someone outside can say, so a seat says it: POST /reach-check { port,
// nonce } and the seat connects back to the ASKING ADDRESS on that port, asks GET /reach-nonce, and answers whether the nonce came
// back - and the address it saw, which is the asker's public IP.
//
// NOT AN OPEN PROXY, NOT A PORT SCANNER: the seat connects only to the address the request came from, only to a public address
// (never loopback, private, link-local or CGNAT), only to the one path, and it answers only whether the nonce came back - never
// what it read, and never whether the port refused or stayed silent (that would tell an open port from a closed one on any host
// whose address an asker can name in a header behind this seat's proxies). At most REACH_PER_MINUTE asks per address and
// REACH_ALL_PER_MINUTE in all. The asker knows its own network: the installer says what blocks it.
import net from 'node:net';
import http from 'node:http';

export const REACH_TIMEOUT_MS = 5000;
export const REACH_PER_MINUTE = 6;
export const REACH_ALL_PER_MINUTE = 60;
const NONCE = /^[A-Za-z0-9_-]{16,64}$/;

/** The 8 groups of a v6 address (a dotted v4 tail allowed), or null. A zone (fe80::1%eth0) is link-scoped: null. */
function v6Groups(a) {
  if (!net.isIPv6(a) || a.includes('%')) return null;
  let s = a.toLowerCase();
  const dotted = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    if (!net.isIPv4(dotted[2])) return null;
    const [p, q, r, t] = dotted[2].split('.').map(Number);
    s = dotted[1] + ((p << 8) | q).toString(16) + ':' + ((r << 8) | t).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const part = (h) => (h ? h.split(':') : []);
  const head = part(halves[0]), tail = halves.length === 2 ? part(halves[1]) : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const g = [...head, ...Array(fill).fill('0'), ...tail].map((x) => (/^[0-9a-f]{1,4}$/.test(x) ? parseInt(x, 16) : NaN));
  return g.length === 8 && g.every((x) => Number.isInteger(x)) ? g : null;
}
const v4Of = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

/**
 * kanban #3700 (report #464): ONE spelling per address. A v4 address as is; any v6 spelling of a v4-mapped (::ffff:0:0/96, every
 * form: 0:0:0:0:0:ffff:7f00:1, ::FFFF:127.0.0.1, zero-padded) or v4-compatible (::/96 but :: and ::1) address as the dotted v4 it
 * names; any other v6 address compressed and lower case (RFC 5952); anything else (a zone, '127.1', '0x7f.0.0.1', a bare integer,
 * brackets) as given - isPublicAddress refuses it. The check, the dial and the rate bucket all take this one spelling.
 */
export function canonicalAddress(ip) {
  const a = String(ip || '').trim();
  if (net.isIPv4(a)) return a;
  const g = v6Groups(a);
  if (!g) return a;
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || (g[5] === 0 && (g[6] !== 0 || g[7] > 1)))) return v4Of(g[6], g[7]);
  let best = [-1, 0];
  for (let i = 0; i < 8;) {
    if (g[i] !== 0) { i++; continue; }
    let j = i; while (j < 8 && g[j] === 0) j++;
    if (j - i > best[1] && j - i > 1) best = [i, j - i];
    i = j;
  }
  const hex = g.map((x) => x.toString(16));
  if (best[0] < 0) return hex.join(':');
  return `${hex.slice(0, best[0]).join(':')}::${hex.slice(best[0] + best[1]).join(':')}`;
}

const publicV4 = (a) => {
  const [p, q] = a.split('.').map(Number);
  return !(p === 0 || p === 10 || p === 127 || p >= 224 || (p === 100 && q >= 64 && q < 128) || (p === 169 && q === 254)
    || (p === 172 && q >= 16 && q < 32) || (p === 192 && q === 168) || (p === 198 && (q === 18 || q === 19)));
};

/**
 * Is this an address a seat may connect back to: public unicast, v4 or v6, in ANY spelling (kanban #3700: read as canonicalAddress).
 * Refused v6 besides loopback/unspecified/ULA/link- and site-local/multicast/documentation: every range that embeds or translates a
 * v4 address the seat cannot judge or that reaches a private one - ::/96, ::ffff:0:0/96, ::ffff:0:0:0/96 (SIIT), 64:ff9b::/96 and
 * 64:ff9b:1::/48 (NAT64), 2001::/32 (Teredo), 2002::/16 (6to4) unless the v4 inside is public.
 */
export function isPublicAddress(ip) {
  const a = canonicalAddress(ip);
  if (net.isIPv4(a)) return publicV4(a);
  const g = v6Groups(a);
  if (!g) return false;
  if (g.slice(0, 6).every((x) => x === 0)) return false;                                          // ::, ::1, ::/96
  if (g.slice(0, 4).every((x) => x === 0) && (g[4] === 0xffff || g[4] === 0) && g[5] === 0) return false;  // ::ffff:0:a.b.c.d (SIIT), ::/80 rest
  if (g.slice(0, 5).every((x) => x === 0)) return false;                                          // anything else under ::/80
  const [h0, h1, h2] = g;
  if (h0 === 0x64 && h1 === 0xff9b && (h2 === 0 || h2 === 1)) return false;                       // NAT64
  if (h0 === 0x2001 && (h1 === 0 || h1 === 0xdb8)) return false;                                  // Teredo, documentation
  if (h0 === 0x2002) return publicV4(v4Of(h1, h2));                                               // 6to4
  if ((h0 & 0xfe00) === 0xfc00 || (h0 & 0xffc0) === 0xfe80 || (h0 & 0xffc0) === 0xfec0 || (h0 & 0xff00) === 0xff00) return false;
  if (h0 === 0x100 && h1 === 0 && h2 === 0 && g[3] === 0) return false;                           // 100::/64 discard
  if (h0 === 0x3fff && h1 < 0x1000) return false;                                                 // 3fff::/20 documentation
  return true;
}

/**
 * The asker's address: the socket's peer, or - when the peer is this machine's own proxy (the seats sit behind tailscale serve/funnel,
 * cloudflared and the tn4 local proxy) - the address OUR proxies saw.
 *
 * ONLY OUR OWN HOPS ARE TRUSTED (kanban #3055, audit h2h r4-2-1; owner decision 2026-11-22). The first X-Forwarded-For hop is whatever the
 * client wrote (nginx $proxy_add_x_forwarded_for, Cloudflare and the tn4 local proxy append after it), and cf-connecting-ip is a plain
 * client header on every path Cloudflare is not in front of (tailscale funnel passes it as sent; measured 2026-11-22 on the funnel:
 * a client's cf-connecting-ip was taken as the asker). So a stranger named a fresh source per throwaway key and evicted a real player
 * from a head-to-head table (presenceSource). Now:
 * - X-Forwarded-For: the RIGHT-MOST hop, the one the proxy in front of us appended (tailscale serve/funnel sets the header to the source
 *   alone; Cloudflare appends the address it saw). Loopback hops at the right end are our own proxies on this machine (the tn4 local
 *   proxy appends cloudflared's 127.0.0.1) and are skipped; a loopback hop can only sit at the right end if one of our proxies wrote it.
 * - cf-connecting-ip only when ARENA_TRUST_CF_CONNECTING_IP=1: a seat that only Cloudflare reaches (no funnel, no other door to the
 *   loopback port), where the edge overwrites it with the real address.
 * Every address is read as canonicalAddress (kanban #3700): the old '::ffff:' strip turned ::ffff:808:808 into '808:808'.
 */
const LOOPBACK = (a) => a === '127.0.0.1' || a === '::1' || /^127\./.test(a);
export function askerAddress(req, { env = process.env } = {}) {
  const peer = canonicalAddress(req.socket.remoteAddress);
  if (LOOPBACK(peer)) {
    if (env.ARENA_TRUST_CF_CONNECTING_IP === '1') {
      const cf = String(req.headers['cf-connecting-ip'] || '').trim();
      if (cf) return canonicalAddress(cf);
    }
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => canonicalAddress(s)).filter(Boolean);
    while (xff.length && LOOPBACK(xff[xff.length - 1])) xff.pop();
    return xff.length ? xff[xff.length - 1] : peer;
  }
  return peer;
}

/**
 * The door's logic. `connectBack(ip, port, nonce)` answers { reached, ms, why } (default: an http GET). `allowPrivate` is for tests.
 * Answers { status, body }.
 */
export function createReachCheck({ connectBack = httpConnectBack, nowMs = () => Date.now(), allowPrivate = false } = {}) {
  const asks = new Map();   // ip -> [ms...]
  let all = [];
  return async function reachCheck(req, body) {
    const ip = canonicalAddress(askerAddress(req));   // kanban #3700: checked, dialed and counted in one spelling
    const port = Number(body && body.port);
    const nonce = String((body && body.nonce) || '');
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { status: 400, body: { ok: false, why: 'port is 1 to 65535' } };
    if (!NONCE.test(nonce)) return { status: 400, body: { ok: false, why: 'nonce is 16 to 64 characters of [A-Za-z0-9_-]' } };
    if (!allowPrivate && !isPublicAddress(ip)) return { status: 400, body: { ok: false, why: `${ip} is not a public address: nothing outside can reach it`, address: ip } };
    const now = nowMs();
    const recent = (asks.get(ip) || []).filter((t) => now - t < 60000);
    if (recent.length >= REACH_PER_MINUTE) return { status: 429, body: { ok: false, why: `at most ${REACH_PER_MINUTE} checks a minute`, address: ip } };
    all = all.filter((t) => now - t < 60000);
    if (all.length >= REACH_ALL_PER_MINUTE) return { status: 429, body: { ok: false, why: 'this seat is busy with reach checks: ask another one', address: ip } };
    recent.push(now); asks.set(ip, recent); all.push(now);
    if (asks.size > 10000) for (const [k, v] of asks) if (!v.some((t) => now - t < 60000)) asks.delete(k);
    const r = await connectBack(ip, port, nonce);
    return { status: 200, body: { ok: true, reached: Boolean(r.reached), address: ip, port, ms: r.reached ? r.ms : undefined } };
  };
}

/**
 * GET http://ip:port/reach-nonce on a connection of its own (no pool: a kept-alive socket would answer for a port that has since
 * closed, and the seat's routed fetch is for its peers), and does the body equal the nonce? Nothing read is handed back.
 */
export function httpConnectBack(ip, port, nonce, timeoutMs = REACH_TIMEOUT_MS) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve({ ...r, ms: Date.now() - t0 }); } };
    const req = http.request({ host: ip, port, path: '/reach-nonce', method: 'GET', agent: false, timeout: timeoutMs, headers: { connection: 'close' } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { if (text.length < 128) text += d; });
      res.on('end', () => finish(text.trim() === nonce ? { reached: true }
        : { reached: false, why: `something answers on ${port}, but not with the nonce (HTTP ${res.statusCode})` }));
    });
    req.on('timeout', () => { req.destroy(); finish({ reached: false, why: `no answer from ${ip}:${port} in ${timeoutMs / 1000} s: a firewall drops it, or the router does not forward it` }); });
    req.on('error', (e) => finish({ reached: false, why: e.code === 'ECONNREFUSED' ? `${ip} refused port ${port}: nothing listens there, or a firewall rejects it`
      : `${ip}:${port}: ${e.code || e.message}` }));
    req.end();
  });
}
