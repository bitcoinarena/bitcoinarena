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

/** Is this an address a seat may connect back to: public unicast, v4 or v6. */
export function isPublicAddress(ip) {
  const a = String(ip || '').replace(/^::ffff:/, '');
  if (net.isIPv4(a)) {
    const [p, q] = a.split('.').map(Number);
    return !(p === 0 || p === 10 || p === 127 || p >= 224 || (p === 100 && q >= 64 && q < 128) || (p === 169 && q === 254)
      || (p === 172 && q >= 16 && q < 32) || (p === 192 && q === 168) || (p === 198 && (q === 18 || q === 19)));
  }
  if (net.isIPv6(a)) {
    const l = a.toLowerCase();
    return !(l === '::' || l === '::1' || /^f[cd]/.test(l) || /^fe[89ab]/.test(l) || /^ff/.test(l) || l.startsWith('2001:db8') || l.startsWith('64:ff9b'));
  }
  return false;
}

/**
 * The asker's address: the socket's peer, or - when the peer is this machine's own proxy (the seats sit behind cloudflared and
 * tailscale serve) - the address the first proxy saw: Cloudflare's cf-connecting-ip, else the first X-Forwarded-For hop.
 */
export function askerAddress(req) {
  const peer = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (peer === '127.0.0.1' || peer === '::1') {
    const cf = String(req.headers['cf-connecting-ip'] || '').trim();
    if (cf) return cf.replace(/^::ffff:/, '');
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    return xff.length ? xff[0].replace(/^::ffff:/, '') : peer;
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
    const ip = askerAddress(req);
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
