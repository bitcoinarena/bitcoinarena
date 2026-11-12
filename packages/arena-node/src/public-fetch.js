// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A URL A STRANGER NAMED IS FETCHED ONLY ON THE PUBLIC INTERNET (kanban #1809, #2236). The faucet's bounty address (feedback-store.js) and a
// winner's or donation recipient's Lightning address (winnings-send.js, POST /payout-address) are URLs a stranger picks; each seat that fetches
// one must never ask a host inside our network for it. #1809 put this guard in the faucet only; #2236 moved it here so every door shares it.
import { lookup as dnsLookup } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { lightningAddressEndpoint } from '../../arena-protocol/src/lnurl-pay.js';

// NEVER AN INTERNAL HOST BY WHERE THE NAME LEADS (kanban #1809, #1489 r6): #1511 judged the host by its spelling, so a public name that resolves to
// 127.0.0.1 (127.0.0.1.nip.io, localtest.me) or a tailnet MagicDNS name (*.ts.net) was fetched. Now the name is resolved and every address it gives must
// be global (no loopback, private, link-local, CGNAT 100.64/10 - Tailscale -, ULA, documentation, multicast or reserved), *.ts.net is refused by name,
// and only the default HTTPS port is asked. The default fetcher connects only to an address that passed this check (its lookup is the guard, so DNS
// rebinding between the check and the connect cannot swap it) and follows no redirect.
const NOT_GLOBAL = new BlockList();
for (const [net, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]) NOT_GLOBAL.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [['::', 127], ['100::', 64], ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]]) NOT_GLOBAL.addSubnet(net, bits, 'ipv6');
export function addressIsGlobal(address) {
  const a = String(address || '').toLowerCase().replace(/^\[|\]$/g, '');
  const v = isIP(a);
  if (v === 4) return !NOT_GLOBAL.check(a, 'ipv4');
  if (v !== 6) return false;
  // an IPv4 address carried in IPv6 (mapped ::ffff:a.b.c.d, NAT64 64:ff9b::/96, the old compatible ::a.b.c.d) is judged as that IPv4 address
  const tail = /^(?:::ffff:|64:ff9b::|::)(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (tail) return addressIsGlobal(tail[1]);
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(a);
  if (hex) { const x = parseInt(hex[1], 16), y = parseInt(hex[2], 16); return addressIsGlobal(`${x >> 8}.${x & 255}.${y >> 8}.${y & 255}`); }
  if (/^64:ff9b:/.test(a) || /^::ffff:/.test(a)) return false;
  return !NOT_GLOBAL.check(a, 'ipv6');
}
// dns.lookup that answers only global addresses (an error naming the host otherwise) - the default fetcher's connect lookup and the check before any fetch
export function globalLookup(hostname, options, cb) {
  if (typeof options === 'function') { cb = options; options = {}; }
  dnsLookup(hostname, { all: true, verbatim: true }, (err, list) => {
    if (err) return cb(err);
    if (!list || !list.length || list.some((x) => !addressIsGlobal(x.address))) { const e = new Error(`${hostname} leads to an internal address`); e.code = 'EINTERNALHOST'; return cb(e); }
    if (options && options.all) return cb(null, list);
    return cb(null, list[0].address, list[0].family);
  });
}
// 'internal' (refuse), 'ok', or 'unresolved' (the name does not resolve now: the fetch will fail on its own, and the default fetcher re-checks at connect)
export function hostReach(url) {
  let u; try { u = new URL(url); } catch { return Promise.resolve('internal'); }
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (u.protocol !== 'https:' || (u.port && u.port !== '443') || u.username || u.password) return Promise.resolve('internal');
  if (internalByName(host)) return Promise.resolve('internal');
  return new Promise((resolve) => globalLookup(host, {}, (err) => resolve(!err ? 'ok' : err.code === 'EINTERNALHOST' ? 'internal' : 'unresolved')));
}
// the default fetcher: an HTTPS GET pinned to the checked address, no redirect followed, at most 64 KB read
const WALLET_ANSWER_MOST = 64 * 1024;
export function walletFetch(url, { signal, headers } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, { method: 'GET', headers, lookup: globalLookup, signal }, (res) => {
      const parts = []; let n = 0;
      res.on('data', (c) => { n += c.length; if (n > WALLET_ANSWER_MOST) { req.destroy(new Error('its answer is too large')); return; } parts.push(c); });
      res.on('end', () => resolve(new Response(Buffer.concat(parts), { status: res.statusCode >= 200 && res.statusCode <= 599 ? res.statusCode : 502 })));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

// A HOST REFUSED BY ITS NAME ALONE (kanban #1511, #1809, #2236): an IP literal, a bare name, a local-only suffix, a tailnet name (*.ts.net), and the
// public wildcard names that lead back to an address spelled inside them (127.0.0.1.nip.io, 127-0-0-1.sslip.io, 7f000001.nip.io, localtest.me):
// those resolve to an internal address, and the name is refused even where DNS does not answer at the check.
const LOCAL_SUFFIX = /(^|\.)(localhost|local|internal|lan|home|arpa|localdomain|intranet|onion|ts\.net|beta\.tailscale\.net|nip\.io|sslip\.io|xip\.io|traefik\.me|localtest\.me|lvh\.me|vcap\.me|localhost\.direct)$/;
export function internalByName(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  return !host || /^\[|^\d+(\.\d+){3}$|^\d+$|^0x/i.test(host) || !host.includes('.') || isIP(host) !== 0 || LOCAL_SUFFIX.test(host)
    || /(^|[.-])\d{1,3}([.-]\d{1,3}){3}([.-]|$)/.test(host);
}

/** The origin-free "host[:port]" a URL names, lower case, for the operator's own list of local LNURL hosts. */
export const hostOf = (url) => { try { const u = new URL(String(url)); return u.port ? `${u.hostname.toLowerCase()}:${u.port}` : u.hostname.toLowerCase(); } catch { return ''; } };

/**
 * WHY A PLAYER'S LIGHTNING ADDRESS IS REFUSED BEFORE IT IS KEPT (kanban #2236), or null: a winner names it at POST /payout-address and every signer
 * node of the committee fetches it at settlement. Refused: one LUD-16 does not take (lightningAddressEndpoint), a port other than 443, a host refused
 * by its name (internalByName - an IP literal, a local suffix, *.ts.net, an .onion: no seat runs a Tor proxy). `localHosts`: the operator's own
 * "host[:port]" list (a regtest harness's local LNURL server, ARENA_LNURL_LOCAL_HOSTS) - never a player's choice.
 */
export function payoutAddressRefusal(address, { localHosts = [] } = {}) {
  const where = lightningAddressEndpoint(address);
  if (!where.ok) return where.why;
  if (localHosts.includes(where.host)) return null;
  const [name, port] = where.host.split(':');
  if (port && port !== '443') return `${where.host} names a port: a Lightning address is on the wallet's public HTTPS name, with no port`;
  if (internalByName(name)) return `${where.host} is not a public name: a Lightning address is on the wallet's public HTTPS name`;
  return null;
}
