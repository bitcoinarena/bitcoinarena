// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// OBJECTIONS AND EQUIVOCATION PROOFS GO TO THE ROUND'S PUBLICATION RELAYS TOO (spec §25.2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { relayPost, relayMarks } from '../src/relay.js';

test('relayPost posts the same body to every relay, and counts those that took it', async () => {
  const seen = [];
  const fetcher = async (url, init) => { seen.push([url, init.method, init.body]); return new Response('x', { status: url.includes('bad') ? 422 : 201 }); };
  const body = new Uint8Array([1, 2, 3]);
  const r = await relayPost(['http://a.example/', 'http://bad.example'], '/objection?round=aa&entry=bb', body, { fetcher });
  assert.deepEqual(seen.map((x) => [x[0], x[1]]), [['http://a.example/objection?round=aa&entry=bb', 'POST'], ['http://bad.example/objection?round=aa&entry=bb', 'POST']]);
  assert.equal(seen[0][2], body);
  assert.equal(r.sent, 1);
  assert.match(r.failed[0], /bad\.example: 422/);
});

test('relayMarks hands every mark to every relay over /play, in order; a silent relay times out by name', async () => {
  const got = [];
  const wss = new WebSocketServer({ port: 0 });
  wss.on('connection', (ws, req) => { ws.on('message', (m) => { got.push([req.url, Buffer.from(m).toString('hex')]); ws.send('ok'); }); });
  await new Promise((r) => wss.on('listening', r));
  const silent = new WebSocketServer({ port: 0 });
  await new Promise((r) => silent.on('listening', r));
  try {
    const r = await relayMarks([`http://127.0.0.1:${wss.address().port}`, `http://127.0.0.1:${silent.address().port}/`],
      [Uint8Array.from([0xaa]), Uint8Array.from([0xbb])], { timeoutMs: 1500 });
    assert.deepEqual(got, [['/play', 'aa'], ['/play', 'bb']]);
    assert.equal(r.sent, 1);
    assert.match(r.failed[0], /no answer/);
  } finally { wss.close(); silent.close(); }
});
