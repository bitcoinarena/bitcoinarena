// Audit gossip r3 #1: /guardian-api/<name> relay (carryApi) keeps every whole message a stranger sends while the upstream
// websocket to the named guardian's census endpoint is still opening - unbounded, with no handshake deadline. The #2075 budget
// (messageBudget) only counts UNFINISHED messages and releases them as soon as a message is whole, so it does not bound this queue.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as tcpServer } from 'node:net';
import { createServer as httpServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { createP2pTunnels, carryApi, GUARDIAN_API_RELAY_PATH } from '../src/p2p-tunnel.js';
import { messageBudget } from '../src/body-budget.js';

const listening = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('a stranger cannot pile whole messages into the /guardian-api relay while the guardian\'s endpoint never answers the upgrade', async () => {
  // ONE CENSUS NODE (role b) whose advertised endpoint takes the TCP connection and never answers the websocket upgrade
  const sockets = [];
  const tarpit = tcpServer((s) => { sockets.push(s); s.on('error', () => {}); });
  const tarpitPort = await listening(tarpit);
  const me = '11'.repeat(32), other = '22'.repeat(32);
  const t = createP2pTunnels({ ownKey: me, listen: () => ({ on() {}, listen() {}, close() {} }) });
  t.sync([{ pubkey: other, advert: { guardianCapable: true, endpoint: `http://127.0.0.1:${tarpitPort}` } }]);

  // THE SEAT, wired as server.js does it (p2pWss maxPayload 4 MiB, the #2075 message budget of 8 MiB, carryApi to rootOf(name))
  const wsMessages = messageBudget({ total: 8 * 1024 * 1024, perAddress: 4 * 1024 * 1024, reserve: 2 * 1024 * 1024, messageMs: 15000 });
  const p2pWss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  let taken = 0;
  const http = httpServer((req, res) => res.end('seat'));
  http.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    const at = new URL(req.url, 'http://node').pathname;
    const root = at.startsWith(GUARDIAN_API_RELAY_PATH) ? t.rootOf(at.slice(GUARDIAN_API_RELAY_PATH.length)) : null;
    if (!root) { socket.end('HTTP/1.1 404 Not Found\r\n\r\n'); return; }
    p2pWss.handleUpgrade(req, socket, head, (ws) => {
      wsMessages.watch(ws, socket);
      carryApi(ws, root);
      ws.on('message', (m) => { taken += m.length; });   // every message the relay took (and queued in `held`)
    });
  });
  const seatPort = await listening(http);

  // THE STRANGER: 48 whole messages of 1 MiB each
  const c = new WebSocket(`ws://127.0.0.1:${seatPort}${GUARDIAN_API_RELAY_PATH}${other.slice(0, 16)}`);
  let closed = false;
  c.on('close', () => { closed = true; }); c.on('error', () => {});
  await new Promise((r) => c.on('open', r));
  const mib = Buffer.alloc(1024 * 1024, 7);
  for (let i = 0; i < 48 && !closed; i++) { c.send(mib); await wait(20); }
  await wait(1500);
  const upstreamOpen = sockets.length;
  try {
    assert.ok(upstreamOpen >= 1, 'the relay is dialling the guardian\'s endpoint');
    assert.ok(closed || taken <= 8 * 1024 * 1024,
      `the relay must bound what it holds while the upstream never opens; it took ${(taken / 1048576).toFixed(0)} MiB into its queue and the connection is still open`);
  } finally {
    try { c.terminate(); } catch { /* gone */ }
    for (const ws of p2pWss.clients) ws.terminate();
    for (const s of sockets) s.destroy();
    http.close(); tarpit.close(); t.close();
  }
});
