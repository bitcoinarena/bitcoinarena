// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// OBJECTIONS AND EQUIVOCATION PROOFS GO TO THE ROUND'S PUBLICATION RELAYS TOO (spec §25.2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { relayPost, relayMarks, postTranscript, relayTargets } from '../src/relay.js';

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

// kanban #808 (5e7fe7e0 VOID 2026-10-31: every relay in the signed contract named a machine that had gone)
const door = (kept = new Map(), dead = new Set()) => async (url, o = {}) => {
  if ([...dead].some((d) => url.startsWith(d))) throw new Error('fetch failed');
  if (o.method === 'PUT') { kept.set(url, o.body); return { ok: true, status: 201 }; }
  return { ok: true, arrayBuffer: async () => kept.get(url).buffer };
};
const same = (a, b) => Buffer.compare(a, b) === 0;

test('relays named in the contract all gone: the transcript goes to the committee at its announced addresses', async () => {
  const kept = new Map();
  const r = await postTranscript({ listed: ['http://dead:1', 'http://dead:2'], announced: ['https://new-tunnel.example/a', 'https://new-tunnel.example/b'], path: '/transcript/ab',
    bytes: new Uint8Array([1, 2]), fetcher: door(kept, new Set(['http://dead'])), sameBytes: same });
  assert.deepEqual(r.held, ['https://new-tunnel.example/a', 'https://new-tunnel.example/b']);
  assert.equal(r.refused.length, 2);
  assert.ok(kept.has('https://new-tunnel.example/a/transcript/ab'));
});

test('a listed relay that holds it: no announced address is asked, and an address named twice is asked once', async () => {
  const kept = new Map();
  const r = await postTranscript({ listed: ['http://up:1/', 'http://up:2'], announced: ['http://up:1', 'http://other:3'], path: '/t', bytes: new Uint8Array([7]), fetcher: door(kept), sameBytes: same });
  assert.deepEqual(r.held, ['http://up:1/', 'http://up:2']);
  assert.equal(kept.size, 2);
  assert.deepEqual(relayTargets(['http://a/', 'http://b'], ['http://a', 'http://c']), ['http://a', 'http://b', 'http://c']);
});

test('nobody holds it: nothing is posted, and each refusal is said', async () => {
  const r = await postTranscript({ listed: ['http://dead:1'], announced: ['http://dead:2'], path: '/t', bytes: new Uint8Array([7]), fetcher: door(new Map(), new Set(['http://dead'])), sameBytes: same });
  assert.deepEqual([r.held, r.refused.length], [[], 2]);
});

