// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// OUR OWN TESTNET4 API (kanban #656, 2026-10-25: "also do our own API for the testnet installer"): the block API's three routes
// from bitcoind, the Electrum protocol over a websocket, ours first in the installer's lists, and the bridge going on to the next block
// API when one does not answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChainApi } from '../../../tools/chain-api.mjs';
import { electrumSession, TESTNET4_ELECTRUM, ARENA_ELECTRUM } from '../src/chain-test.js';
import { ESPLORAS_TESTNET4, ARENA_ESPLORA } from '../src/chain-bridge.js';

const listen = (server) => new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server.address().port)));

test('the block API: tip height, a block\'s status and bytes, from bitcoind; anything else refused', async (t) => {
  const H = 'ab'.repeat(32);
  const call = async (m, p) => {
    if (m === 'getblockcount') return 157576;
    if (m === 'getblockheader') { if (p[0] !== H) throw new Error('Block not found'); return { height: 157575, confirmations: 2, nextblockhash: 'cd'.repeat(32) }; }
    if (m === 'getblock') { if (p[0] !== H) throw new Error('Block not found'); return '00ff'; }
    throw new Error(m);
  };
  const server = createChainApi({ call });
  const port = await listen(server);
  const at = (p) => fetch(`http://127.0.0.1:${port}${p}`, { headers: { connection: 'close' } });
  t.after(() => { server.closeAllConnections(); server.close(); });
  assert.equal(await (await at('/blocks/tip/height')).text(), '157576');
  assert.deepEqual(await (await at(`/block/${H}/status`)).json(), { in_best_chain: true, height: 157575, next_best: 'cd'.repeat(32) });
  assert.deepEqual(await (await at(`/block/${'ee'.repeat(32)}/status`)).json(), { in_best_chain: false });
  assert.deepEqual([...Buffer.from(await (await at(`/block/${H}/raw`)).arrayBuffer())], [0, 255]);
  assert.equal((await at(`/block/${'ee'.repeat(32)}/raw`)).status, 404);
  assert.equal((await at('/tx/1')).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${port}/blocks/tip/height`, { method: 'POST' })).status, 405);
});

test('the Electrum protocol over a websocket; ours first in both lists', async (t) => {
  const { WebSocketServer } = await import('ws');
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((ok) => wss.on('listening', ok));
  wss.on('connection', (c) => c.on('message', (m) => { const q = JSON.parse(String(m)); c.send(JSON.stringify(q.method === 'server.version' ? { id: q.id, result: ['Fulcrum 2.1.3', '1.4'] } : { id: q.id, error: { message: 'no such method' } })); }));
  t.after(() => wss.close());
  const s = await electrumSession({ host: '127.0.0.1', port: wss.address().port, tls: false, ws: true, path: '/electrum' });
  assert.deepEqual(await s.call('server.version', ['arena', '1.4']), ['Fulcrum 2.1.3', '1.4']);
  await assert.rejects(s.call('nope'), /no such method/);
  s.close();
  assert.deepEqual(TESTNET4_ELECTRUM[0], ARENA_ELECTRUM);
  assert.deepEqual([ARENA_ELECTRUM.ws, ARENA_ELECTRUM.path, ARENA_ELECTRUM.port], [true, '/electrum', 443]);
  assert.equal(ESPLORAS_TESTNET4[0], ARENA_ESPLORA);
});
