// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Feedback #026 (kanban #2569): /gateway/... was piped to the gateway before served()/read(), so ARENA_BODY_MOST (#1469) did not apply. A declared body over
// the limit is refused before the gateway is asked; a streamed one is cut at the limit; a body within it still reaches the gateway as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';

process.env.ARENA_BODY_MOST = '4096';
const { serve } = await import('../src/server.js');
const { openStore } = await import('../src/store.js');

const post = (port, path, body, { chunked = false } = {}) => new Promise((resolve) => {
  const req = request({ host: '127.0.0.1', port, method: 'POST', path, headers: chunked ? { 'transfer-encoding': 'chunked' } : { 'content-length': Buffer.byteLength(body) } }, (r) => {
    let t = ''; r.on('data', (c) => { t += c; }); r.on('end', () => resolve({ status: r.statusCode, text: t })); });
  req.on('error', (e) => resolve({ status: 0, text: e.message }));
  if (chunked) { for (let i = 0; i < body.length; i += 1000) req.write(body.slice(i, i + 1000)); req.end(); } else req.end(body);
});

test('#026 a gateway call over ARENA_BODY_MOST is refused, declared or streamed; one within it reaches the gateway', async () => {
  const got = [];
  const gw = createServer((req, res) => { let n = 0; req.on('data', (c) => { n += c.length; }); req.on('end', () => { got.push(n); res.writeHead(200); res.end('ok'); }); });
  await new Promise((r) => gw.listen(0, '127.0.0.1', r));
  process.env.ARENA_GATEWAY_PORT = String(gw.address().port);
  const seat = await serve(openStore(':memory:'), { port: 0 });
  try {
    const big = 'x'.repeat(100 * 1024);
    const declared = await post(seat.port, '/gateway/v1/test', big);
    const streamed = await post(seat.port, '/gateway/v1/test', big, { chunked: true });
    const small = await post(seat.port, '/gateway/v1/test', 'y'.repeat(1000));
    console.log('  FACTS #026:', JSON.stringify({ declared: declared.status, streamed: streamed.status, small: small.status, gatewaySaw: got }));
    assert.equal(declared.status, 413, 'a declared 100 KB body is refused');
    assert.ok(streamed.status === 413 || streamed.status === 0, `a streamed 100 KB body is cut (${streamed.status})`);
    assert.equal(small.status, 200, 'a body within the limit still reaches the gateway');
    assert.ok(!got.some((n) => n > 4096), `the gateway never received more than the limit: ${JSON.stringify(got)}`);
  } finally { delete process.env.ARENA_GATEWAY_PORT; await seat.close(); await new Promise((r) => gw.close(r)); }
});
