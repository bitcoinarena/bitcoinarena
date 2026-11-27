// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHAT A NODE'S ADDRESS MUST BE, SAID AT INPUT (kanban #3887, node operators 2026-11: a bare IP, http:// and odd ports were set as public_url
// and posted; the Arena page is https, so browsers block every request to such an address as mixed content, and players never reach the
// node). An address the network can use: https, on port 443, a name (not an IP) with a valid certificate; the guardian's endpoint the same
// name over wss:// at /guardian. The one exception to 443: Tailscale Funnel's own ports 8443 and 10000 on a *.ts.net name (valid
// certificates, the only ports Funnel offers). No dependency: the owner page's bundle imports this file too.

export const FUNNEL_HTTPS_PORTS = Object.freeze(['8443', '10000']);

/** How to get such an address, in short. */
export const ADDRESS_HOW_TO = 'Use a name with a valid certificate on port 443: your own domain, or a free dynamic-DNS name (for example DuckDNS) pointed at this machine, with Caddy or nginx and Let\'s Encrypt in front of the node\'s port; or a named Cloudflare tunnel (Services, Address: Your own domain); or Tailscale Funnel.';

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** Why `url` cannot be a node's public address, or null when it can. { why, howTo } - why in one sentence. */
export function addressRefusal(url) {
  const raw = String(url || '').trim();
  const no = (why) => ({ why, howTo: ADDRESS_HOW_TO });
  if (!raw) return no('no address given');
  let u; try { u = new URL(raw); } catch { return no(`${raw} is not an address (it starts with https://)`); }
  if (u.protocol === 'http:' || u.protocol === 'ws:') return no(`${raw} is not https: the Arena page is https, and browsers block every request from it to an http address (mixed content)`);
  if (u.protocol !== 'https:') return no(`${raw} is not an https address`);
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (IPV4.test(host) || host.includes(':')) return no(`${host} is a bare IP address: no public certificate names an IP, so browsers refuse it`);
  if (!host.includes('.') || /(^|\.)(localhost|local|internal|lan|home\.arpa)$/.test(host)) return no(`${host} is not a public name`);
  if (u.port && !(host.endsWith('.ts.net') && FUNNEL_HTTPS_PORTS.includes(u.port))) return no(`port ${u.port}: a node's address is on port 443 (no port in the address), where every network lets https through`);
  if (u.username || u.password || u.search || u.hash) return no(`${raw} carries a login, a query or a fragment: an address is only https://<name>`);
  return null;
}

/** The guardian endpoint for `publicUrl`: wss://<same name>/guardian. Why `guardianUrl` is not it, or null. */
export function guardianEndpointRefusal(guardianUrl, publicUrl) {
  if (!guardianUrl) return null;
  const want = String(publicUrl || '').trim().replace(/\/+$/, '').replace(/^https:/i, 'wss:') + '/guardian';
  if (!/^wss:\/\//i.test(String(guardianUrl))) return { why: `guardian_endpoint ${guardianUrl} is not wss://: the guardian is reached over the node's own https address (${want})`, howTo: ADDRESS_HOW_TO };
  if (publicUrl && String(guardianUrl).trim().replace(/\/+$/, '').toLowerCase() !== want.toLowerCase()) return { why: `guardian_endpoint ${guardianUrl} is not ${want}: it names another address than public_url`, howTo: ADDRESS_HOW_TO };
  return null;
}
