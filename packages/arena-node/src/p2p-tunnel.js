// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE GUARDIANS' P2P, THROUGH THE NODES (kanban #562, the owner 2026-10-21 ~07:00Z: "Lieber Tunneln damit wir nicht immer neue
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

const hexOf = (k) => (typeof k === 'string' ? k : Buffer.from(k).toString('hex')).toLowerCase();

/** The local port a guardian's P2P URL names: the same on every node, from its node key and slot. */
export function p2pTunnelPort(nodeKey, slot = 'guardian') {
  if (!P2P_TUNNEL_PATHS[slot]) throw new Error(`p2p tunnel: no slot ${slot}`);
  const h = createHash('sha256').update(`BLWP/p2p-tunnel/${slot}/${hexOf(nodeKey)}`).digest();
  return P2P_TUNNEL_BASE + (h.readUInt32BE(0) % P2P_TUNNEL_SPAN);
}

/** INBOUND: a websocket the seat accepted on /guardian-p2p, carried byte for byte to the guardian's local P2P port. */
export function carryP2p(ws, port, { host = '127.0.0.1', connect = netConnect } = {}) {
  const stream = createWebSocketStream(ws);
  const up = connect({ host, port });
  stream.pipe(up); up.pipe(stream);
  const done = () => { try { up.destroy(); } catch { /* gone */ } try { stream.destroy(); } catch { /* gone */ } };
  up.on('error', done); stream.on('error', done); up.on('close', done); stream.on('close', done);
  return { close: done };
}

/** A census endpoint as the root its websocket paths hang off: ws(s), no trailing slash. */
export const tunnelRoot = (endpoint) => String(endpoint || '').trim().replace(/^http(s?):/i, 'ws$1:').replace(/\/+$/, '');

/**
 * OUTBOUND: the listeners for every other guardian-capable node of the census. `ownKey` this node's key; `sync(entries)`
 * once in a while with the newest census entries - it opens a listener for a node that came in, points an open one at
 * a node's new endpoint, and closes one whose node left. `state()` what each port serves.
 */
export function createP2pTunnels({ ownKey, host = '127.0.0.1', say = () => {}, openWs = (url) => new WebSocket(url, { maxPayload: 64 * 1024 * 1024 }),
  listen = createServer }) {
  const own = hexOf(ownKey);
  const ports = new Map();   // port -> { key, slot, root, server, state: 'listening' | 'shared' | 'opening', connections }
  function open(port, row) {
    const server = listen((sock) => {
      const target = ports.get(port);
      if (!target || !target.root) { sock.destroy(); return; }
      const ws = openWs(`${target.root}${P2P_TUNNEL_PATHS[target.slot]}`);
      sock.pause();
      ws.on('open', () => {
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
  function sync(entries) {
    const want = new Map();
    for (const e of entries || []) {
      const a = e && e.advert;
      if (!(a && a.guardianCapable === true && a.endpoint)) continue;
      const key = hexOf(e.pubkey);
      if (key === own) continue;
      for (const slot of Object.keys(P2P_TUNNEL_PATHS)) want.set(p2pTunnelPort(key, slot), { key, slot, root: tunnelRoot(a.endpoint) });
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
  return { sync, close, state };
}
