// shared harness for the #3062 refute (skeptic 2) tests: a seat wired as server.js wires /guardian-api (p2pWss 4 MiB, the #2075 budget, carryApi)
// with one or more census nodes, each its own endpoint
import { createServer as tcpServer } from 'node:net';
import { createServer as httpServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { createP2pTunnels, carryApi, GUARDIAN_API_RELAY_PATH } from '../src/p2p-tunnel.js';
import { messageBudget } from '../src/body-budget.js';
export const listening = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
export const wait = (ms) => new Promise((r) => setTimeout(r, ms));
export async function tarpitEndpoint() {
  const sockets = []; const srv = tcpServer((s) => { sockets.push(s); s.on('error', () => {}); });
  const port = await listening(srv);
  return { endpoint: `http://127.0.0.1:${port}`, sockets, close: () => { for (const s of sockets) s.destroy(); srv.close(); } };
}
/** a census node's guardian API: `onConn(ws, rawSocket)` per relay that reaches it */
export async function guardianEndpoint(onConn) {
  const raws = [];
  const g = httpServer(); const gw = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
  g.on('upgrade', (req, socket, head) => { socket.on('error', () => {}); gw.handleUpgrade(req, socket, head, (ws) => { raws.push(socket); ws.on('error', () => {}); onConn(ws, socket); }); });
  const port = await listening(g);
  return { endpoint: `http://127.0.0.1:${port}`, raws, close: () => { for (const r of raws) r.destroy(); g.close(); } };
}
export async function seat(endpoints) {
  const keys = endpoints.map((_, i) => String(i + 2).repeat(64).slice(0, 64));
  const t = createP2pTunnels({ ownKey: '11'.repeat(32), listen: () => ({ on() {}, listen() {}, close() {} }) });
  t.sync(endpoints.map((endpoint, i) => ({ pubkey: keys[i], advert: { guardianCapable: true, endpoint } })));
  const wsMessages = messageBudget({ total: 8 * 1024 * 1024, perAddress: 4 * 1024 * 1024, reserve: 2 * 1024 * 1024, messageMs: 15000 });
  const p2pWss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  const conns = [];
  const http = httpServer((req, res) => res.end('seat'));
  http.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    const at = new URL(req.url, 'http://node').pathname;
    const root = at.startsWith(GUARDIAN_API_RELAY_PATH) ? t.rootOf(at.slice(GUARDIAN_API_RELAY_PATH.length)) : null;
    if (!root) { socket.end('HTTP/1.1 404 Not Found\r\n\r\n'); return; }
    p2pWss.handleUpgrade(req, socket, head, (ws) => {
      wsMessages.watch(ws, socket);
      carryApi(ws, root);
      const c = { ws, open: true }; conns.push(c);
      ws.on('close', () => { c.open = false; });
    });
  });
  const port = await listening(http);
  const urls = keys.map((k) => `ws://127.0.0.1:${port}${GUARDIAN_API_RELAY_PATH}${k.slice(0, 16)}`);
  return { urls, conns, close: () => { for (const ws of p2pWss.clients) ws.terminate(); http.close(); t.close(); } };
}
export function client(url) {
  const c = new WebSocket(url, { maxPayload: 128 * 1024 * 1024 }); const s = { c, closed: false, got: [] };
  c.on('close', () => { s.closed = true; }); c.on('error', () => {}); c.on('message', (m) => s.got.push(m));
  return new Promise((r, j) => { c.on('open', () => r(s)); c.on('error', j); });
}
