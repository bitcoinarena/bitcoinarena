// ONE NODE IS ONE GUARDIAN, AND THE NODE RUNS IT (spec §23A.2, RULED the owner 2026-09-26 22:54): a node started with no
// guardian config starts its guardian, the guardian's endpoint is the node's own public address, and stopping the node
// stops it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { guardianPorts, guardianEnv, fedimintNetwork, funnelBaseFor, guardianEndpoint, startGuardian } from '../src/guardian.js';

// Tailscale's own answers, as `tailscale status --json` / `tailscale funnel status --json` give them on the test host
const TS = {
  status: { Self: { DNSName: 'seat.example.com.' } },
  funnel: {
    AllowFunnel: { 'seat.example.com:443': true },
    Web: { 'seat.example.com:443': { Handlers: {
      '/': { Proxy: 'http://localhost:3001' },
      '/blwp-a': { Proxy: 'http://198.51.100.7:18080' },
      '/guardian-1': { Proxy: 'http://127.0.0.1:31221' },
      '/guardian-2': { Proxy: 'http://127.0.0.1:31231' } } } },
  },
};

test('the guardian is derived from the node: ports, network, and the testnet4 wallet module', () => {
  assert.deepEqual(guardianPorts(31221), { api: 32221, p2p: 33221, ui: 34221, metrics: 35221 });
  assert.equal(fedimintNetwork('testnet4'), 'regtest', "Fedimint 0.12's own label for a chain it does not know");
  assert.equal(fedimintNetwork('regtest'), 'regtest');
  assert.equal(fedimintNetwork('main'), 'bitcoin');
  assert.throws(() => fedimintNetwork('nonsense'), /does not run on/);
  const t4 = guardianEnv({ nodePort: 31221, dataDir: '/d', network: 'regtest', chain: 'testnet4', bitcoindUrl: 'http://127.0.0.1:48332',
    cookieSecret: 's', password: 'p', endpoint: 'wss://x/guardian-1/guardian' });
  assert.equal(t4.FM_API_URL, 'wss://x/guardian-1/guardian');
  assert.equal(t4.FM_BIND_API, '127.0.0.1:32221', 'the guardian binds locally; the public side is the node');
  assert.equal(t4.FM_BITCOIN_NETWORK, 'regtest', 'the label Fedimint itself gives testnet4');
  assert.equal(t4.FM_ENABLE_MODULE_WALLETV2, 'false', 'walletv2 panics on testnet4 (RULED 2026-09-26)');
  assert.equal(t4.FM_ENABLE_MODULE_WALLET, 'true', "Fedimint's stock wallet module on testnet4");
  assert.equal(t4.FM_DISABLE_BASE_FEES, '1');
  const rt = guardianEnv({ nodePort: 18080, dataDir: '/d', network: 'regtest', bitcoindUrl: 'u', cookieSecret: 's', password: 'p', endpoint: 'e' });
  assert.equal(rt.FM_ENABLE_MODULE_WALLETV2, undefined, 'regtest keeps the rehearsal defaults');
});

test("the endpoint is the node's own public address: the Funnel path that proxies to its port, never one the operator names", () => {
  assert.equal(funnelBaseFor(31221, TS), 'seat.example.com/guardian-1');
  assert.equal(guardianEndpoint(31231, { tailscale: TS }), 'wss://seat.example.com/guardian-2/guardian');
  assert.equal(funnelBaseFor(31299, TS), null, 'no public path reaches this port');
  assert.equal(guardianEndpoint(31299, { host: '127.0.0.1', tailscale: TS }), 'ws://127.0.0.1:31299/guardian');
  const closed = { ...TS, funnel: { ...TS.funnel, AllowFunnel: {} } };
  assert.equal(funnelBaseFor(31221, closed), null, 'a path served only on the tailnet is not public');
});

test("the node carries its guardian's websocket at /guardian, and /play and every other path are as before", async () => {
  // a stand-in guardian API: a websocket that answers what it is sent
  const api = createServer(); const echo = new WebSocketServer({ server: api });
  echo.on('connection', (ws, req) => ws.on('message', (m) => ws.send(`guardian heard ${m} on ${req.url}`)));
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  const node = await serve(openStore(':memory:'), { port: 0,
    guardian: { apiPort: api.address().port, endpoint: 'wss://seat.example.com/guardian-1/guardian' } });
  try {
    const said = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${node.port}/guardian`);
      ws.on('open', () => ws.send('status'));
      ws.on('message', (m) => { resolve(String(m)); ws.close(); });
      ws.on('error', reject);
    });
    assert.equal(said, 'guardian heard status on /', 'the guardian sees its own root');
    const play = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${node.port}/play`);
      ws.on('open', () => { resolve('open'); ws.close(); }); ws.on('error', (e) => resolve(e.message));
    });
    assert.equal(play, 'open', '/play still upgrades');
    const other = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${node.port}/elsewhere`);
      ws.on('open', () => resolve('open')); ws.on('error', (e) => resolve(e.message));
    });
    assert.match(other, /400/, 'any other path is still refused');
    const r = await (await fetch(`http://127.0.0.1:${node.port}/guardian`)).json();
    assert.deepEqual(r, { guardian: true, endpoint: 'wss://seat.example.com/guardian-1/guardian' });
  } finally { await node.close(); echo.close(); api.close(); }
  const plain = await serve(openStore(':memory:'), { port: 0 });
  try {
    assert.deepEqual(await (await fetch(`http://127.0.0.1:${plain.port}/guardian`)).json(), { guardian: false });
  } finally { await plain.close(); }
});

test('starting the node starts its guardian with nothing configured for it, and stopping it stops the guardian', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'guardian-test-'));
  const cookie = join(dir, '.cookie'); writeFileSync(cookie, '__cookie__:sekrit');
  const call = async (m) => { assert.equal(m, 'getblockchaininfo'); return { chain: 'testnet4' }; };
  const quiet = () => {};
  // no chain, and no fedimintd: not a guardian, said by name, and the node still starts
  const noChain = await startGuardian({ nodePort: 31221, host: '127.0.0.1', storePath: join(dir, 'a.db'), log: quiet });
  assert.equal(noChain.running, false); assert.match(noChain.why, /reads no chain/);
  const noBin = await startGuardian({ nodePort: 31221, host: '127.0.0.1', storePath: join(dir, 'a.db'), bitcoindUrl: 'http://127.0.0.1:48332',
    cookiePath: cookie, call, env: { PATH: join(dir, 'empty') }, tailscale: TS, log: quiet });
  assert.equal(noBin.running, false); assert.match(noBin.why, /no fedimintd/);
  // a stand-in fedimintd on the PATH that writes down what it was started with, then waits to be stopped
  const bin = join(dir, 'bin'); const seen = join(dir, 'seen.json');
  const { mkdirSync } = await import('node:fs'); mkdirSync(bin);
  writeFileSync(join(bin, 'fedimintd'), `#!/bin/sh\nenv | grep '^FM_' > ${seen}\nexec sleep 60\n`); chmodSync(join(bin, 'fedimintd'), 0o755);
  const g = await startGuardian({ nodePort: 31221, host: '127.0.0.1', storePath: join(dir, 'a.db'), bitcoindUrl: 'http://127.0.0.1:48332',
    cookiePath: cookie, call, env: { PATH: `${bin}:/usr/bin:/bin` }, tailscale: TS, log: quiet });
  try {
    assert.equal(g.running, true);
    assert.equal(g.endpoint, 'wss://seat.example.com/guardian-1/guardian', "the node's own public address");
    for (let i = 0; i < 50 && !existsSync(seen); i++) await new Promise((r) => setTimeout(r, 100));
    const env = Object.fromEntries(readFileSync(seen, 'utf8').trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    assert.equal(env.FM_API_URL, 'wss://seat.example.com/guardian-1/guardian');
    assert.equal(env.FM_BITCOIN_NETWORK, 'regtest', "testnet4, read off the node's own bitcoind, under Fedimint's own label");
    assert.equal(env.FM_ENABLE_MODULE_WALLET, 'true', "the stock wallet module on the testnet4 chain");
    assert.equal(env.FM_BITCOIND_PASSWORD, 'sekrit', "the node's own cookie");
    assert.equal(env.FM_DATA_DIR, join(dir, 'a.db.guardian'), "beside the node's store");
    assert.ok(existsSync(join(dir, 'a.db.guardian', 'admin-password')), 'its admin password made by the node, not typed');
  } finally { await g.stop(); }
  let alive = true; try { process.kill(g.pid, 0); } catch { alive = false; }
  assert.equal(alive, false, 'stopping the node stops its guardian');
});
