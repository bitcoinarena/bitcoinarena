// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A NAME IS CHECKED WHERE IT RESOLVES, WHEN THE CONNECTION IS MADE (kanban #3133, wf1489 refute of #3082/#3124): the address book's name
// rule (peerEndpointRefusal, localHostName) is a fixed list - it refuses IP literals, localhost, local suffixes and the known rebinding
// names, but cannot know where any other name resolves. A bond committing http://x.lacolhost.com:18777/lnurlp, http://localh.st:18777/... or
// its own domain with an A record of 127.0.0.1 passed it, and every honest seat sent GET <that>/<door> to its own loopback service.
//
// This module gives the process's fetch and WebSocket (Node's own undici: globalThis.fetch, globalThis.WebSocket, and the keep-alive Agent
// fetch-routes.js makes) a connect-time lookup: a NAME that resolves to a loopback, private, link-local, CGNAT, ULA or reserved address
// (public-fetch internalAddress) fails the connection. Not checked (the name rule decides those, and a devnet needs them):
//   - IP literals (no lookup happens) and names the name rule already calls local (localhost, *.local, a single label, *.nip.io ...);
//   - every name while this node runs local seats (setDialLocalOk - the address book's own localOk; ARENA_LOCAL_SEATS=1 before it is set);
//   - the targets the operator chose: the hosts on the right of ARENA_ROUTE_MAP and FM_WS_API_CONNECT_OVERRIDES, and ARENA_DIAL_INTERNAL_OK
//     (a comma list of host names the operator's own services sit behind on a private address);
//   - a tailnet name (*.ts.net) on a tailnet address (100.64/10, fd7a:115c:a1e0::/48): live seats announce those and MagicDNS answers them.
import { lookup as dnsLookup } from 'node:dns';
import { internalAddress } from './public-fetch.js';
import { localHostName } from '../../arena-client/src/node-discovery.js';

let localOkFn = () => process.env.ARENA_LOCAL_SEATS === '1';
/** The node's own "local seats" rule (server.js passes the address book's): while it says true, no resolved address is refused. */
export function setDialLocalOk(fn) { localOkFn = typeof fn === 'function' ? fn : () => !!fn; }

const hostOf = (u) => { try { return new URL(String(u).replace(/^ws(s?):/i, 'http$1:')).hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, ''); } catch { return null; } };
/** The host names the operator named as its own targets (route map and override right sides, ARENA_DIAL_INTERNAL_OK). */
export function operatorHosts(env = process.env) {
  const out = new Set();
  for (const v of [env.ARENA_ROUTE_MAP, env.FM_WS_API_CONNECT_OVERRIDES]) {
    for (const pair of String(v || '').split(',')) { const i = pair.indexOf('='); if (i > 0) { const h = hostOf(pair.slice(i + 1).trim()); if (h) out.add(h); } }
  }
  for (const h of String(env.ARENA_DIAL_INTERNAL_OK || '').split(',').map((x) => x.trim().toLowerCase().replace(/\.$/, '')).filter(Boolean)) out.add(h);
  return out;
}

const tailnetAddress = (a) => { const s = String(a).toLowerCase(); return /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(s) || s.startsWith('fd7a:115c:a1e0:'); };

/** Why `hostname` may not be dialed at the resolved `addresses` ([{ address }]), or null. */
export function resolvedRefusal(hostname, addresses, { localOk = false, operator = operatorHosts() } = {}) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (localOk || !h || h === 'localhost' || localHostName(h) || operator.has(h)) return null;
  const tailnet = h.endsWith('.ts.net');
  const bad = (addresses || []).find((x) => internalAddress(x.address) && !(tailnet && tailnetAddress(x.address)));
  return bad ? `${h} resolves to ${bad.address}, a loopback or private address` : null;
}

let operatorKept = null;
/** A dns.lookup that fails the connection when the name resolves to an internal address (resolvedRefusal). */
export function guardedLookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  const opts = typeof options === 'number' ? { family: options } : { ...(options || {}) };
  dnsLookup(hostname, opts, (err, address, family) => {
    if (err) { callback(err); return; }
    const list = Array.isArray(address) ? address : [{ address, family }];
    let localOk = false; try { localOk = !!localOkFn(); } catch { localOk = false; }
    const why = resolvedRefusal(hostname, list, { localOk, operator: operatorKept || (operatorKept = operatorHosts()) });
    if (why) { callback(Object.assign(new Error(`not dialed: ${why} (kanban #3133)`), { code: 'EARENA_INTERNAL_ADDRESS', hostname })); return; }
    callback(null, address, family);
  });
}

/** The connect options every Agent of this process takes (fetch-routes.js keepAliveDispatcher adds them to its own). */
export const dialConnect = () => ({ lookup: guardedLookup });

// INSTALLED ONCE, AS THE PROCESS'S OWN DISPATCHER: Node's fetch and WebSocket read it at every call. Reading globalThis.WebSocket loads
// Node's undici and makes its Agent, whose class makes ours (no undici package is shipped).
// WHERE NODE KEEPS IT (kanban #3539): Node 24's undici (7.x) reads 'undici.globalDispatcher.1' and puts the same Agent under '.2' too;
// Node 26's (8.x) reads '.2' and keeps under '.1' only a Dispatcher1Wrapper of that Agent for older undici copies - a wrapper whose class
// takes a dispatcher, not Agent options ("Argument dispatcher must implement dispatch"). So the Agent class is taken from '.2' when there
// is one, and the guarded Agent is put where the old one was: in both slots when they held the same Agent, under '.2' with a new wrapper
// of it under '.1' when '.1' was a wrapper.
const SYM1 = Symbol.for('undici.globalDispatcher.1');
const SYM2 = Symbol.for('undici.globalDispatcher.2');
/** The Agent Node's own fetch dispatches through (undici 8 under '.2', undici 7 under '.1'), or null before undici is loaded. */
export function nativeGlobalAgent() { return globalThis[SYM2] || globalThis[SYM1] || null; }
/** True when the dispatcher Node's fetch reads is this module's guarded Agent. */
export function dialGuardInstalled() { const g = nativeGlobalAgent(); return !!(g && g.arenaDialGuard); }
function install() {
  try {
    if (dialGuardInstalled()) return;
    void globalThis.fetch; void globalThis.WebSocket;
    const g1 = globalThis[SYM1], g2 = globalThis[SYM2], g = g2 || g1;
    if (!g || typeof g.constructor !== 'function') return;
    const agent = new g.constructor({ connect: dialConnect() });
    agent.arenaDialGuard = true;
    if (g2 && g1 && g1 !== g2) {
      globalThis[SYM2] = agent;
      try { const w = new g1.constructor(agent); w.arenaDialGuard = true; globalThis[SYM1] = w; }
      catch (e) { console.error(`[dial-guard] legacy dispatcher slot not replaced: ${e.message}`); }
    } else {
      if (g2) globalThis[SYM2] = agent;
      globalThis[SYM1] = agent;
    }
  } catch (e) { console.error(`[dial-guard] not installed: ${e.message}`); }
}
install();
