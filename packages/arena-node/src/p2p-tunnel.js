// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE GUARDIANS' P2P, THROUGH THE NODES (kanban #562, 2026-10-21 ~07:00Z: "Lieber Tunneln damit wir nicht immer neue
// ads brauchen"). Fedimint's guardians run their consensus over a P2P link of their own - TLS over TCP to each peer's P2P
// URL - and every guardian of a node set up by hand or by the installer named `fedimint://127.0.0.1:<port>`: measured
// 2026-10-21, federation B's config (node-1.db.guardian/local.json) lists its seven peers at 127.0.0.1:8221..8281. That
// works only while every guardian runs on one machine. A peer's P2P URL is written into the federation's config at the key
// ceremony and never changes, while a node's address does (a quick tunnel's name changes on every restart). So:
//
//   THE URL    each guardian names `fedimint://127.0.0.1:<p2pTunnelPort(node key, slot)>` - a port every node derives the
//              same from the census, fixed for as long as the node key is;
//   OUTBOUND   every node listens on 127.0.0.1 at that port for each other guardian-capable node of the census, and carries
//              each connection to that node's CURRENT census endpoint, `<endpoint>/guardian-p2p` (or /guardian-next-p2p),
//              as a websocket - an address change needs only an advertisement update, never a new federation;
//   INBOUND    the seat takes /guardian-p2p and carries it to its own guardian's local P2P port (carryP2p below).
//
// Nothing is trusted on the way: fedimint's P2P is mutually TLS-authenticated with the keys of the ceremony, so a tunnel
// that reached the wrong node would only fail the handshake. Several nodes on one machine (the test host tests) share the
// listeners - a port another seat there already serves is left to it.
import { createServer, connect as netConnect } from 'node:net';
import { createHash } from 'node:crypto';
import { WebSocket, createWebSocketStream } from 'ws';

/** The range the tunnel's ports are drawn from: below the ephemeral range, clear of the live guardian ports (32221-35281). */
export const P2P_TUNNEL_BASE = 20000, P2P_TUNNEL_SPAN = 10000;
/** The seat's path for each guardian slot's P2P. */
export const P2P_TUNNEL_PATHS = Object.freeze({ guardian: '/guardian-p2p', next: '/guardian-next-p2p' });

// A TUNNEL THAT IS NEVER IDLE (kanban #495, measured 2026-10-21 16:18-16:34Z on the 10-node founding 082e74b3: the guardians' P2P
// connections to the installer nodes, behind Cloudflare quick tunnels, closed every ~2 min 05 s - "peer closed connection without
// sending TLS close_notify" - a proxy's idle cut of a websocket that carried nothing for 100 s, then the reconnect; the cuts came at the
// DKG's start (16:19:08-16:19:23) and every guardian stayed at "Exchanging raw bytes" from 16:19:24): each end pings its websocket
// every P2P_KEEPALIVE_MS, so the proxy always sees traffic.
export const P2P_KEEPALIVE_MS = 30000;
function keepAlive(ws, everyMs = P2P_KEEPALIVE_MS) {
  const t = setInterval(() => { if (ws.readyState === 1) { try { ws.ping(); } catch { /* closing */ } } }, everyMs);
  if (t.unref) t.unref();
  ws.on('close', () => clearInterval(t));
  return () => clearInterval(t);
}

const hexOf = (k) => (typeof k === 'string' ? k : Buffer.from(k).toString('hex')).toLowerCase();

/** The local port a guardian's P2P URL names: the same on every node, from its node key and slot. */
export function p2pTunnelPort(nodeKey, slot = 'guardian') {
  if (!P2P_TUNNEL_PATHS[slot]) throw new Error(`p2p tunnel: no slot ${slot}`);
  const h = createHash('sha256').update(`BLWP/p2p-tunnel/${slot}/${hexOf(nodeKey)}`).digest();
  return P2P_TUNNEL_BASE + (h.readUInt32BE(0) % P2P_TUNNEL_SPAN);
}

/** INBOUND: a websocket the seat accepted on /guardian-p2p, carried byte for byte to the guardian's local P2P port. */
export function carryP2p(ws, port, { host = '127.0.0.1', connect = netConnect, keepAliveMs = P2P_KEEPALIVE_MS } = {}) {
  const stop = keepAlive(ws, keepAliveMs);
  const stream = createWebSocketStream(ws);
  const up = connect({ host, port });
  stream.pipe(up); up.pipe(stream);
  const done = () => { stop(); try { up.destroy(); } catch { /* gone */ } try { stream.destroy(); } catch { /* gone */ } };
  up.on('error', done); stream.on('error', done); up.on('close', done); stream.on('close', done);
  return { close: done };
}

// THE GUARDIANS' API, THROUGH THE NODES TOO (kanban #577, measured 2026-10-26 on federation e2f42eea): a federation's config names
// each guardian's API at the address its node had at the key ceremony - for the installer nodes a quick tunnel, gone at the next
// restart. A guardian that falls one session behind catches up by asking its peers' API for the signed session, so once the
// tunnels had changed six of ten guardians sat in session 736 for good ("Failed to fetch consensus version from peer" for every
// peer), and the federation halted with two peg-outs unsigned. So the seat hands its guardian FM_WS_API_CONNECT_OVERRIDES that
// send each peer's config address to the seat itself, `<seat>/guardian-api/<the peer's name>`, and the seat carries the
// websocket to that peer's CURRENT census endpoint `<endpoint>/guardian` - the same address the P2P tunnel follows. The
// overrides never change; only where the seat carries them does.
export const GUARDIAN_API_RELAY_PATH = '/guardian-api/';
export const GUARDIAN_NEXT_PATH = '/guardian-next';

/**
 * The overrides a guardian is started with: each peer's API URL in the federation's config (`apiEndpoints`, the client config's
 * `api_endpoints`: { peerId: { url, name } }) -> the seat's relay for that peer's name; its own -> its local API port. `seatRoot`
 * the seat's own ws://host:port. Kept: the entries of `existing` for an address not named here. Answers the variable's value.
 */
export function guardianApiOverrides({ apiEndpoints, ownName = null, seatRoot, ownApiPort = null, existing = '' }) {
  const out = new Map();
  for (const p of Object.values(apiEndpoints || {})) {
    if (!p || typeof p.url !== 'string' || typeof p.name !== 'string' || !/^[0-9a-f]{8,64}$/i.test(p.name)) continue;
    // A SEAT HOLDS TWO FEDERATIONS' GUARDIANS (kanban #1032, measured 2026-11-02 15:50Z: federation 4dc88be7 stood from 12:00Z, its guardians asked their peers for a finished
    // session through this relay and reached each node's first federation, session 9243 against 25533, and waited for ever): a peer named at .../guardian-next is carried there
    const next = /\/guardian-next\/?$/.test(p.url) ? GUARDIAN_NEXT_PATH : '';
    const to = ownName && p.name.toLowerCase() === String(ownName).toLowerCase() && ownApiPort ? `ws://127.0.0.1:${ownApiPort}/`
      : `${seatRoot}${GUARDIAN_API_RELAY_PATH}${p.name.toLowerCase()}${next}`;
    const url = p.url.replace(/\/+$/, '');
    for (const v of [url, `${url}/`]) out.set(v, to);
  }
  for (const pair of String(existing || '').split(',')) {
    const i = pair.indexOf('=');
    if (i > 0 && !out.has(pair.slice(0, i).replace(/\/+$/, '')) && !out.has(pair.slice(0, i))) out.set(pair.slice(0, i), pair.slice(i + 1));
  }
  return [...out].map(([from, to]) => `${from}=${to}`).join(',');
}

/** The relay: a websocket the seat accepted on /guardian-api/<name>, its messages carried both ways to `<root>/guardian`. */
export function carryApi(ws, root, { openWs = (url) => new WebSocket(url, { maxPayload: 64 * 1024 * 1024 }), keepAliveMs = P2P_KEEPALIVE_MS, path = '/guardian' } = {}) {
  const up = openWs(`${root}${path}`);
  const held = [];
  const stopDown = keepAlive(ws, keepAliveMs);
  const done = () => { stopDown(); try { up.close(); } catch { /* gone */ } try { ws.close(); } catch { /* gone */ } };
  ws.on('message', (m, binary) => { if (up.readyState === 1) up.send(m, { binary }); else held.push([m, binary]); });
  up.on('open', () => { keepAlive(up, keepAliveMs); for (const [m, binary] of held.splice(0)) up.send(m, { binary }); });
  up.on('message', (m, binary) => { if (ws.readyState === 1) ws.send(m, { binary }); });
  up.on('close', done); up.on('error', done); ws.on('close', done); ws.on('error', done);
  return { close: done };
}

/** A census endpoint as the root its websocket paths hang off: ws(s), no trailing slash. */
// A MACHINE THAT CANNOT REACH THE FUNNEL HOST (kanban #808: the second machine gets no socket from seat.example.com, so its guardian never caught up with its peers):
// ARENA_TUNNEL_HOST_MAP "from=to,from=to" sends a peer's tunnels over the host's other public name
const TUNNEL_HOSTS = String(process.env.ARENA_TUNNEL_HOST_MAP || '').split(',').map((x) => x.split('=')).filter((x) => x.length === 2 && x[0] && x[1]);
export const tunnelRoot = (endpoint) => TUNNEL_HOSTS.reduce((u, [from, to]) => u.split(`//${from}`).join(`//${to}`),
  String(endpoint || '').trim().replace(/^http(s?):/i, 'ws$1:').replace(/\/+$/, ''));

/**
 * OUTBOUND: the listeners for every other guardian-capable node of the census. `ownKey` this node's key; `sync(entries)`
 * once in a while with the newest census entries - it opens a listener for a node that came in, points an open one at
 * a node's new endpoint, and closes one whose node left. `state()` what each port serves.
 */
export function createP2pTunnels({ ownKey, host = '127.0.0.1', say = () => {}, openWs = (url) => new WebSocket(url, { maxPayload: 64 * 1024 * 1024 }),
  listen = createServer, keepAliveMs = P2P_KEEPALIVE_MS }) {
  const own = hexOf(ownKey);
  const ports = new Map();   // port -> { key, slot, root, server, state: 'listening' | 'shared' | 'opening', connections }
  function open(port, row) {
    const server = listen((sock) => {
      const target = ports.get(port);
      if (!target || !target.root) { sock.destroy(); return; }
      // AN ERROR BEFORE THE TUNNEL IS OPEN (kanban #677, measured 2026-10-26 on inst577-2: "read ECONNRESET ... Unhandled 'error' event"
      // ended the node): fedimintd may reset its connection while the websocket to a slow or dead tunnel is still opening, and a socket
      // with no error listener throws - it is listened to from the start, and its websocket closed with it
      sock.on('error', () => { try { ws.terminate(); } catch { /* not open */ } });
      const ws = openWs(`${target.root}${P2P_TUNNEL_PATHS[target.slot]}`);
      sock.pause();
      ws.on('open', () => {
        keepAlive(ws, keepAliveMs);
        const stream = createWebSocketStream(ws);
        stream.pipe(sock); sock.pipe(stream); sock.resume();
        const done = () => { try { sock.destroy(); } catch { /* gone */ } try { stream.destroy(); } catch { /* gone */ } };
        stream.on('error', done); sock.on('error', done); stream.on('close', done); sock.on('close', done);
      });
      ws.on('error', (e) => { say(`[p2p-tunnel] ${port} -> ${target.root}: ${e.message}`); sock.destroy(); });
      target.connections++;
    });
    row.server = server; row.state = 'opening';
    server.on('error', (e) => {
      // A PORT ANOTHER SEAT ON THIS MACHINE SERVES is left to it, and asked again at the next sync
      row.state = e.code === 'EADDRINUSE' ? 'shared' : 'failed'; row.why = e.message; row.server = null;
    });
    server.listen(port, host, () => { row.state = 'listening'; say(`[p2p-tunnel] ${port} carries ${row.slot} ${row.key.slice(0, 8)} to ${row.root}`); });
  }
  // `prefer(keyHex)`: true for a node a federation record this seat holds names as a guardian (kanban #1226)
  function sync(entries, { prefer = null } = {}) {
    const want = new Map();
    const preferred = (k) => { try { return typeof prefer === 'function' && !!prefer(k); } catch { return false; } };
    for (const e of entries || []) {
      const a = e && e.advert;
      if (!(a && a.guardianCapable === true && a.endpoint)) continue;
      const key = hexOf(e.pubkey);
      if (key === own) continue;
      for (const slot of Object.keys(P2P_TUNNEL_PATHS)) {
        const port = p2pTunnelPort(key, slot);
        // A GUARDIAN KEEPS ITS PORT (kanban #1226, audit 2 #1204 INSTALLER-DOORS-7): ports are a hash of the node key mod 10,000 and the last
        // census entry on a port won - a key ground to another guardian's port, bonded, cut that guardian off from its federation's peers on
        // every seat. A node a held federation record names as a guardian keeps the port against one no record names.
        const had = want.get(port);
        if (had && had.key !== key) {
          say(`[p2p-tunnel] ${port}: ${had.key.slice(0, 8)} and ${key.slice(0, 8)} map to one port`);
          if (preferred(had.key) && !preferred(key)) continue;
        }
        want.set(port, { key, slot, root: tunnelRoot(a.endpoint) });
      }
    }
    for (const [port, row] of ports) {
      const w = want.get(port);
      if (!w) { if (row.server) row.server.close(); ports.delete(port); continue; }
      if (row.root !== w.root) { say(`[p2p-tunnel] ${port}: ${row.key.slice(0, 8)} moved to ${w.root}`); row.root = w.root; }
      if (!row.server && row.state !== 'opening') open(port, row);
    }
    for (const [port, w] of want) if (!ports.has(port)) { const row = { ...w, server: null, state: 'new', connections: 0 }; ports.set(port, row); open(port, row); }
  }
  function close() { for (const row of ports.values()) if (row.server) row.server.close(); ports.clear(); }
  const state = () => [...ports].map(([port, r]) => ({ port, node: r.key, slot: r.slot, root: r.root, state: r.state, connections: r.connections }));
  /** The current endpoint root of the census node whose key begins with `name` (a guardian's name in the federation config), or null. */
  const rootOf = (name) => {
    const n = String(name || '').toLowerCase();
    if (!/^[0-9a-f]{8,64}$/.test(n)) return null;
    for (const r of ports.values()) if (r.slot === 'guardian' && r.key.startsWith(n) && r.root) return r.root;
    return null;
  };
  return { sync, close, state, rootOf };
}
