// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE WHOLE ANSWER WITHIN THE LIMIT (kanban #395): a seat that sends its headers at once and its body late is as silent as one
// that sends nothing - measured on testnet4: federation B's /rounds bodies took 19-45 s, and the lobby's first read waited for them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { answerWithin } from '../src/lobby.js';

test('headers at once, the body after 1.5 s: not an answer within 400 ms; a quick one is read whole', async () => {
  const srv = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"rounds":[');
    if (req.url === '/slow') setTimeout(() => res.end(']}'), 1500); else res.end(']}');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const ask = answerWithin(fetch, 400);
    const t0 = Date.now();
    await assert.rejects(ask(`${base}/slow`), (e) => e.silent === true);
    assert.ok(Date.now() - t0 < 1000, 'given up at the limit, not at the body\'s end');
    const r = await ask(`${base}/quick`);
    assert.deepEqual(await r.json(), { rounds: [] });
  } finally { srv.closeAllConnections(); srv.close(); }
});

test('half the seats answered: the rest get 2.5 s more, not the full limit', async () => {
  const { fetchLobby, LOBBY_LAST_MS } = await import('../src/lobby.js');
  const slow = new Set(['http://c', 'http://d']);
  const fetcher = (url, opts = {}) => new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(new Response(JSON.stringify({ node: 'ab'.repeat(32), nowMs: Date.now(), rounds: [] }), { status: 200 })), slow.has(new URL(url).origin) ? 8000 : 50);
    if (opts.signal) opts.signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); });
  });
  const t0 = Date.now();
  const got = await fetchLobby({ nodes: ['http://a', 'http://b', 'http://c', 'http://d'], fetcher, verify: () => true, answerMs: 10000 });
  const took = Date.now() - t0;
  assert.ok(took < LOBBY_LAST_MS + 1500, `drawn after ${took} ms`);
  assert.deepEqual(got.unanswered.sort(), ['http://c', 'http://d']);
});
