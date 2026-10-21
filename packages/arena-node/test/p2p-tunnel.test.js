// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE GUARDIANS' P2P THROUGH THE NODES (kanban #562): the port every node derives the same, a connection carried from a
// node's local listener over a websocket to the other node's seat and on to its guardian's P2P port, and a node that moved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as tcpServer, connect } from 'node:net';
import { createServer as httpServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { p2pTunnelPort, createP2pTunnels, carryP2p, tunnelRoot, P2P_TUNNEL_BASE, P2P_TUNNEL_SPAN, P2P_TUNNEL_PATHS } from '../src/p2p-tunnel.js';
import { guardianEnv, guardianPorts } from '../src/guardian.js';

const listening = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** A seat: /guardian-p2p carried to `p2pPort` - as server.js does. Answers its root. */
async function seat(p2pPort) {
  const http = httpServer((req, res) => res.end('seat'));
  const wss = new WebSocketServer({ noServer: true });
  http.on('upgrade', (req, socket, head) => {
    if (new URL(req.url, 'http://x').pathname !== P2P_TUNNEL_PATHS.guardian) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => carryP2p(ws, p2pPort));
  });
  const port = await listening(http);
  return { root: `http://127.0.0.1:${port}`, close: () => { for (const c of wss.clients) c.terminate(); http.close(); } };
}
/** A guardian's P2P port: answers every byte with its tag and the byte. */
async function guardianP2p(tag) {
  const srv = tcpServer((s) => s.on('data', (d) => s.write(`${tag}:${d}`)));
  return { port: await listening(srv), close: () => srv.close() };
}
const ask = (port, msg) => new Promise((resolve, reject) => {
  const c = connect({ host: '127.0.0.1', port }, () => c.write(msg));
  c.on('data', (d) => { resolve(String(d)); c.destroy(); });
  c.on('error', reject);
  setTimeout(() => { c.destroy(); reject(new Error('no answer')); }, 5000);
});

test('the port a guardian names is the same on every node, inside its range, and differs by slot', () => {
  const k = 'ab'.repeat(32);
  const p = p2pTunnelPort(k);
  assert.equal(p, p2pTunnelPort(Buffer.from(k, 'hex')), 'hex or bytes: one port');
  assert.ok(p >= P2P_TUNNEL_BASE && p < P2P_TUNNEL_BASE + P2P_TUNNEL_SPAN);
  assert.notEqual(p2pTunnelPort(k, 'next'), p);
  assert.notEqual(p2pTunnelPort('cd'.repeat(32)), p);
  assert.equal(tunnelRoot('https://a.example/'), 'wss://a.example');
  assert.equal(tunnelRoot('ws://198.51.100.7:6511'), 'ws://198.51.100.7:6511');
});

test('a guardian names that port as its P2P URL; the bind stays local (Fedimint reads the URL at the ceremony only)', () => {
  const env = guardianEnv({ nodePort: 6511, dataDir: '/d', network: 'testnet4', bitcoindUrl: 'http://b', cookieSecret: 'c', password: 'p', endpoint: 'ws://e/guardian',
    p2pUrlPort: p2pTunnelPort('ab'.repeat(32)) });
  assert.equal(env.FM_P2P_URL, `fedimint://127.0.0.1:${p2pTunnelPort('ab'.repeat(32))}`);
  assert.equal(env.FM_BIND_P2P, `127.0.0.1:${guardianPorts(6511).p2p}`);
  const old = guardianEnv({ nodePort: 6511, dataDir: '/d', network: 'testnet4', bitcoindUrl: 'http://b', cookieSecret: 'c', password: 'p', endpoint: 'ws://e/guardian' });
  assert.equal(old.FM_P2P_URL, `fedimint://127.0.0.1:${guardianPorts(6511).p2p}`, 'without a node key: as before');
});

test('a connection to another guardian\'s port reaches its P2P port through its seat, and follows the node to a new address', async () => {
  const me = '11'.repeat(32), other = '22'.repeat(32);
  const g1 = await guardianP2p('first'), g2 = await guardianP2p('second');
  const s1 = await seat(g1.port), s2 = await seat(g2.port);
  const t = createP2pTunnels({ ownKey: me });
  const entry = (endpoint) => [{ pubkey: Buffer.from(other, 'hex'), advert: { guardianCapable: true, endpoint } },
    { pubkey: Buffer.from(me, 'hex'), advert: { guardianCapable: true, endpoint: 'ws://me.invalid' } },
    { pubkey: Buffer.from('33'.repeat(32), 'hex'), advert: { guardianCapable: false, endpoint: 'ws://not.a.guardian' } }];
  try {
    t.sync(entry(s1.root));
    await wait(200);
    const port = p2pTunnelPort(other);
    const st = t.state();
    assert.deepEqual(st.map((x) => x.node).sort(), [other, other], 'its two slots, not this node, not a node that is no guardian');
    assert.equal(st.find((x) => x.port === port).state, 'listening');
    assert.equal(await ask(port, 'hello'), 'first:hello', 'carried to the other node\'s guardian');
    t.sync(entry(s2.root));                          // the node moved: an advertisement update named its new address
    assert.equal(await ask(port, 'again'), 'second:again', 'the same port, the new address');
    t.sync([]);                                      // it left the census
    await wait(100);
    assert.equal(t.state().length, 0);
  } finally { t.close(); s1.close(); s2.close(); g1.close(); g2.close(); }
});
