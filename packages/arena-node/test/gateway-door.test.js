// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE NODE'S GATEWAY AT ITS PUBLIC ADDRESS (spec §23A.9): with ARENA_GATEWAY_PORT the seat carries /gateway/...
// to the gateway on this machine - method, path without /gateway, query, body and the answer as they are - and says so when it is down.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { serve } from '../src/server.js';
import { openStore } from '../src/store.js';

test('/gateway/... reaches the node\'s gateway; without one the seat says it does not answer', async () => {
  const seen = [];
  const gw = createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { seen.push({ m: req.method, u: req.url, b, auth: req.headers.authorization });
    res.writeHead(201, { 'content-type': 'application/json', 'x-gw': '1' }); res.end(JSON.stringify({ ok: true })); }); });
  await new Promise((r) => gw.listen(0, '127.0.0.1', r));
  process.env.ARENA_GATEWAY_PORT = String(gw.address().port);
  const seat = await serve(openStore(':memory:'), { port: 0 });
  try {
    const r = await fetch(`http://127.0.0.1:${seat.port}/gateway/v1/create_bolt11_invoice?x=1`, { method: 'POST', headers: { authorization: 'Bearer pw', 'content-type': 'application/json' }, body: '{"amount_msat":1000}' });
    assert.deepEqual([r.status, r.headers.get('x-gw'), await r.json()], [201, '1', { ok: true }]);
    assert.deepEqual(seen[0], { m: 'POST', u: '/v1/create_bolt11_invoice?x=1', b: '{"amount_msat":1000}', auth: 'Bearer pw' });
    assert.equal((await fetch(`http://127.0.0.1:${seat.port}/identity`)).status, 200, 'the seat\'s own doors as before');
    await new Promise((r) => gw.close(r));
    const down = await fetch(`http://127.0.0.1:${seat.port}/gateway/v1/info`);
    assert.equal(down.status, 502);
    assert.match(await down.text(), /gateway does not answer/);
  } finally { delete process.env.ARENA_GATEWAY_PORT; await seat.close(); }
});
