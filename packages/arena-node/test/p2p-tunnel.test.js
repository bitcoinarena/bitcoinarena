// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE GUARDIANS' P2P THROUGH THE NODES (kanban #562): the port every node derives the same, a connection carried from a
// node's local listener over a websocket to the other node's seat and on to its guardian's P2P port, and a node that moved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as tcpServer, connect } from 'node:net';
import { createServer as httpServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { p2pTunnelPort, createP2pTunnels, carryP2p, carryApi, guardianApiOverrides, tunnelRoot, P2P_TUNNEL_BASE, P2P_TUNNEL_SPAN, P2P_TUNNEL_PATHS, P2P_KEEPALIVE_MS, GUARDIAN_API_RELAY_PATH } from '../src/p2p-tunnel.js';
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
  assert.equal(tunnelRoot('ws://198.51.100.106:6511'), 'ws://198.51.100.106:6511');
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

// A TUNNEL THAT IS NEVER IDLE (kanban #495, measured 2026-10-21: guardians' P2P behind Cloudflare quick tunnels cut every ~2 min 05 s, the
// DKG stalled at "Exchanging raw bytes"): an idle carried connection is pinged from both ends, each end hears the other's pings
test('an idle tunnel is pinged from both ends, well inside a proxy\'s 100 s idle cut', async () => {
  assert.ok(P2P_KEEPALIVE_MS <= 30000, 'every 30 s at most');
  const g = await guardianP2p('g');
  let seatPings = 0;
  const http = httpServer((req, res) => res.end('seat'));
  const wss = new WebSocketServer({ noServer: true });
  http.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => { ws.on('ping', () => seatPings++); carryP2p(ws, g.port, { keepAliveMs: 40 }); }));
  const root = `http://127.0.0.1:${await listening(http)}`;
  let nodePings = 0;
  const key = 'ab'.repeat(32);
  const tunnels = createP2pTunnels({ ownKey: 'cd'.repeat(32), keepAliveMs: 40,
    openWs: (url) => { const ws = new WebSocket(url); ws.on('ping', () => nodePings++); return ws; } });
  tunnels.sync([{ pubkey: Buffer.from(key, 'hex'), advert: { guardianCapable: true, endpoint: root } }]);
  await wait(100);
  const port = p2pTunnelPort(key);
  const sock = connect({ host: '127.0.0.1', port });
  await new Promise((r) => sock.on('connect', r));
  await wait(300);                                   // nothing is written: an idle connection
  assert.ok(seatPings >= 3, `the seat heard the node's pings (${seatPings})`);
  assert.ok(nodePings >= 3, `the node heard the seat's pings (${nodePings})`);
  sock.destroy(); tunnels.close(); for (const c of wss.clients) c.terminate(); http.close(); g.close();
});

// THE GUARDIANS' API THROUGH THE NODES (kanban #577, measured 2026-10-26 on e2f42eea: the config named each guardian's API at its 10-22 quick
// tunnel; once those were gone, six guardians that fell one session behind could not fetch it from any peer and the federation halted)
// A SEAT HOLDS TWO FEDERATIONS' GUARDIANS (kanban #1032): a peer of the second federation is relayed to its /guardian-next, not to the node's first federation
test('a peer named at /guardian-next is relayed to /guardian-next, and carried there', () => {
  const v = guardianApiOverrides({ apiEndpoints: { 0: { url: 'wss://h/fed2-4/guardian-next', name: 'aaaaaaaaaaaaaaaa' }, 1: { url: 'wss://h/fed2-8/guardian', name: 'bbbbbbbbbbbbbbbb' } }, seatRoot: 'ws://127.0.0.1:8470' });
  const m = new Map(v.split(',').map((x) => [x.slice(0, x.indexOf('=')), x.slice(x.indexOf('=') + 1)]));
  assert.equal(m.get('wss://h/fed2-4/guardian-next'), `ws://127.0.0.1:8470${GUARDIAN_API_RELAY_PATH}aaaaaaaaaaaaaaaa/guardian-next`);
  assert.equal(m.get('wss://h/fed2-8/guardian'), `ws://127.0.0.1:8470${GUARDIAN_API_RELAY_PATH}bbbbbbbbbbbbbbbb`);
  const opened = []; const fake = { on() {}, close() {}, readyState: 1, send() {} };
  const openWs = (u) => { opened.push(u); return fake; };
  carryApi(fake, 'wss://h/fed2-4', { openWs, keepAliveMs: 0, path: '/guardian-next' }).close();
  carryApi(fake, 'wss://h/fed2-8', { openWs, keepAliveMs: 0 }).close();
  assert.deepEqual(opened, ['wss://h/fed2-4/guardian-next', 'wss://h/fed2-8/guardian']);
});

test('a guardian is started with each peer\'s config address sent to its seat\'s relay, its own to its local API, and other overrides kept', () => {
  const apiEndpoints = { 0: { url: 'wss://old-a.trycloudflare.com/guardian', name: 'aaaaaaaaaaaaaaaa' }, 1: { url: 'wss://old-b.trycloudflare.com/guardian/', name: 'BBBBBBBBBBBBBBBB' },
    2: { url: 'ws://198.51.100.106:6571/guardian', name: 'cccccccccccccccc' } };
  const v = guardianApiOverrides({ apiEndpoints, ownName: 'cccccccccccccccc', seatRoot: 'ws://127.0.0.1:8470', ownApiPort: 9471, existing: 'wss://other.example/x=ws://127.0.0.1:1/,wss://old-a.trycloudflare.com/guardian=wss://stale' });
  const m = new Map(v.split(',').map((x) => [x.slice(0, x.indexOf('=')), x.slice(x.indexOf('=') + 1)]));
  assert.equal(m.get('wss://old-a.trycloudflare.com/guardian'), `ws://127.0.0.1:8470${GUARDIAN_API_RELAY_PATH}aaaaaaaaaaaaaaaa`);
  assert.equal(m.get('wss://old-a.trycloudflare.com/guardian/'), `ws://127.0.0.1:8470${GUARDIAN_API_RELAY_PATH}aaaaaaaaaaaaaaaa`, 'with and without the trailing slash');
  assert.equal(m.get('wss://old-b.trycloudflare.com/guardian'), `ws://127.0.0.1:8470${GUARDIAN_API_RELAY_PATH}bbbbbbbbbbbbbbbb`);
  assert.equal(m.get('ws://198.51.100.106:6571/guardian'), 'ws://127.0.0.1:9471/', 'its own: the local API port');
  assert.equal(m.get('wss://other.example/x'), 'ws://127.0.0.1:1/', 'an override for another address is kept');
  assert.equal([...m.keys()].filter((k) => k.startsWith('wss://old-a')).length, 2, 'the stale one for a peer\'s address is replaced');
  const env = guardianEnv({ nodePort: 8470, dataDir: '/x', network: 'testnet4', bitcoindUrl: 'http://b', cookieSecret: 'c', password: 'p', endpoint: 'ws://e', apiOverrides: v });
  assert.equal(env.FM_WS_API_CONNECT_OVERRIDES, v);
  assert.equal(guardianEnv({ nodePort: 8470, dataDir: '/x', network: 'testnet4', bitcoindUrl: 'http://b', cookieSecret: 'c', password: 'p', endpoint: 'ws://e' }).FM_WS_API_CONNECT_OVERRIDES, undefined, 'no federation yet: none');
});

test('a peer\'s API asked at the seat\'s relay reaches that peer\'s guardian at its current address, and follows it when it moves', async () => {
  const me = '11'.repeat(32), other = '22'.repeat(32);
  // the peer's seat: /guardian answers each message with its tag (as a guardian's JSON-RPC would answer)
  const peerSeat = async (tag) => {
    const http = httpServer((req, res) => res.end('seat'));
    const wss = new WebSocketServer({ noServer: true });
    http.on('upgrade', (req, socket, head) => {
      if (new URL(req.url, 'http://x').pathname !== '/guardian') { socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, (ws) => ws.on('message', (m) => ws.send(`${tag}:${m}`)));
    });
    const port = await listening(http);
    return { root: `http://127.0.0.1:${port}`, close: () => { for (const c of wss.clients) c.terminate(); http.close(); } };
  };
  const p1 = await peerSeat('first'), p2 = await peerSeat('second');
  const t = createP2pTunnels({ ownKey: me });
  // this node's seat: the relay, as server.js carries it
  const http = httpServer((req, res) => res.end('seat'));
  const wss = new WebSocketServer({ noServer: true });
  http.on('upgrade', (req, socket, head) => {
    const at = new URL(req.url, 'http://x').pathname;
    const root = at.startsWith(GUARDIAN_API_RELAY_PATH) ? t.rootOf(at.slice(GUARDIAN_API_RELAY_PATH.length)) : null;
    if (!root) { socket.end('HTTP/1.1 404 Not Found\r\n\r\n'); return; }
    wss.handleUpgrade(req, socket, head, (ws) => carryApi(ws, root));
  });
  const seatPort = await listening(http);
  const call = (path, msg) => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${seatPort}${path}`);
    ws.on('open', () => ws.send(msg)); ws.on('message', (m) => { resolve(String(m)); ws.close(); }); ws.on('error', reject);
  });
  const entry = (endpoint) => [{ pubkey: Buffer.from(other, 'hex'), advert: { guardianCapable: true, endpoint } }];
  try {
    t.sync(entry(p1.root));
    await wait(100);
    assert.equal(t.rootOf(other.slice(0, 16)), tunnelRoot(p1.root));
    assert.equal(t.rootOf(me.slice(0, 16)), null, 'not this node itself');
    assert.equal(await call(`${GUARDIAN_API_RELAY_PATH}${other.slice(0, 16)}`, 'session_count'), 'first:session_count');
    t.sync(entry(p2.root));                          // the node's quick tunnel changed: the census names its new address
    assert.equal(await call(`${GUARDIAN_API_RELAY_PATH}${other.slice(0, 16)}`, 'session_count'), 'second:session_count', 'the same override, the new address');
    await assert.rejects(call(`${GUARDIAN_API_RELAY_PATH}${'33'.repeat(8)}`, 'x'), 'a name no census guardian has: nothing carried');
  } finally { t.close(); for (const c of wss.clients) c.terminate(); http.close(); p1.close(); p2.close(); }
});

// A RESET BEFORE THE TUNNEL OPENS (kanban #677, measured 2026-10-26 on inst577-2: "read ECONNRESET ... Unhandled 'error' event" ended the
// node): the guardian's connection is reset while the websocket to a dead tunnel is still opening - the node keeps running, the websocket is closed
test('a connection reset while its tunnel is still opening ends that connection, not the node', async () => {
  const thrown = []; const onThrow = (e) => thrown.push(e); process.on('uncaughtException', onThrow);
  const key = 'ef'.repeat(32);
  let terminated = 0;
  const { EventEmitter } = await import('node:events');
  const tunnels = createP2pTunnels({ ownKey: 'cd'.repeat(32), openWs: () => Object.assign(new EventEmitter(), { terminate: () => { terminated++; } }) });   // never opens
  tunnels.sync([{ pubkey: Buffer.from(key, 'hex'), advert: { guardianCapable: true, endpoint: 'http://127.0.0.1:9' } }]);
  await wait(100);
  const sock = connect({ host: '127.0.0.1', port: p2pTunnelPort(key) });
  await new Promise((r) => sock.on('connect', r));
  await wait(50);
  sock.resetAndDestroy();                            // an RST: the node's side reads ECONNRESET
  await wait(200);
  process.off('uncaughtException', onThrow);
  tunnels.close();
  assert.deepEqual(thrown.map((e) => e.code), [], 'nothing thrown');
  assert.equal(terminated, 1, 'the opening websocket was closed with it');
});

// KANBAN #1226 (audit 2 #1204 INSTALLER-DOORS-7): a port is the node key's hash mod 10,000, and the last census entry on a port won - a key
// ground to a guardian's port (about 10,000 tries), bonded, took that guardian's P2P route on every seat. Now a node a held federation record
// names as a guardian keeps its port against one no record names, in either census order.
test('#1226 two keys on one port: the record-named guardian keeps it, whichever comes last in the census', async () => {
  const { randomBytes } = await import('node:crypto');
  const seen = new Map(); let pair = null;
  while (!pair) { const k = randomBytes(32).toString('hex'); const p = p2pTunnelPort(k, 'guardian'); if (seen.has(p) && seen.get(p) !== k) pair = [seen.get(p), k, p]; else seen.set(p, k); }
  const [guardianKey, attacker, port] = pair;
  const entryOf = (k, root) => ({ pubkey: Buffer.from(k, 'hex'), advert: { guardianCapable: true, endpoint: root } });
  for (const order of ['attacker last', 'attacker first']) {
    const t = createP2pTunnels({ ownKey: 'ee'.repeat(32), say: () => {} });
    try {
      const g = entryOf(guardianKey, 'wss://guardian.example'), a = entryOf(attacker, 'wss://attacker.example');
      t.sync(order === 'attacker last' ? [g, a] : [a, g], { prefer: (k) => k === guardianKey });
      const row = t.state().find((r) => r.port === port);
      assert.equal(row && row.node, guardianKey, `${order}: the port went to the key no record names`);
    } finally { t.close(); }
  }
});

// KANBAN #1358 (audit 4 fixesA-7): during a founding no federation record names its guardians, so `prefer` was false for both keys and the later
// census entry took the port - a bonded key ground onto a founding guardian's port hung the founding's DKG on every seat. A founding's seated
// guardian is now preferred (server.js adds foundingSeat.seatedKeys()), and between keys equally preferred the older bond keeps the port.
test('#1257 a founding guardian keeps its port', async () => {
  const { randomBytes } = await import('node:crypto');
  const seen = new Map(); let pair = null;
  while (!pair) { const k = randomBytes(32).toString('hex'); const p = p2pTunnelPort(k, 'guardian'); if (seen.has(p) && seen.get(p) !== k) pair = [seen.get(p), k, p]; else seen.set(p, k); }
  const [founder, attacker, port] = pair;
  const entryOf = (k, root, height) => ({ pubkey: Buffer.from(k, 'hex'), height, advert: { guardianCapable: true, endpoint: root } });
  const got = {};
  for (const [name, prefer] of [['founding seats the founder', (k) => k === founder], ['nobody preferred', () => false]]) {
    for (const order of ['attacker last', 'attacker first']) {
      const t = createP2pTunnels({ ownKey: 'ee'.repeat(32), say: () => {} });
      try {
        const g = entryOf(founder, 'wss://founder.example', 1000), a = entryOf(attacker, 'wss://attacker.example', 1200);
        t.sync(order === 'attacker last' ? [g, a] : [a, g], { prefer });
        const row = t.state().find((r) => r.port === port);
        got[`${name}, ${order}`] = row && row.node === founder ? 'founder' : 'attacker';
      } finally { t.close(); }
    }
  }
  console.log('  MEASURED #1358 port owner:', JSON.stringify(got));
  for (const [k, v] of Object.entries(got)) assert.equal(v, 'founder', k);
});
