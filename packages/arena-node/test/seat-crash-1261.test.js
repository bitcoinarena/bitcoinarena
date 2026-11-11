// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1261 (audit 4 #1257 fixesB-5, outsider-1): two more ways for anyone on the network to end a seat, beside #1252's reset on an upgraded socket.
// (1) An upgrade request whose path is no URL (`//`, or an absolute form like `http://[x`): the upgrade handler's first line parsed it with no try, and a
// throw in a socket's data handler is uncaught - the process ended. (2) The /gateway proxy piped the client's request into the node's gatewayd with an
// error listener on the gatewayd side only: a client's reset mid-body, or while the answer streams back, had none on the client's side.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { createServer } from 'node:http';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { HOSTED } from './plugins/hosted.js';

const raw = (port, bytes, { resetAfterMs = 60 } = {}) => new Promise((done) => {
  const s = connect({ host: '127.0.0.1', port }, () => { s.write(bytes); setTimeout(() => { try { s.resetAndDestroy(); } catch { /* gone */ } done(); }, resetAfterMs); });
  s.on('error', () => done());
});
const upgrade = (path) => `GET ${path} HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`;

async function watched(run) {
  const thrown = []; const catcher = (e) => thrown.push(String(e && (e.code || e.message) || e));
  process.on('uncaughtException', catcher);
  try { return { ...(await run()), thrown }; } finally { process.off('uncaughtException', catcher); }
}

test('#1261 an upgrade request whose path is no URL closes that socket; the seat answers on', async () => {
  const d = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, funded: () => true });
  try {
    const got = await watched(async () => {
      for (const path of ['//', 'http://[x', '//', 'http://[x']) await raw(d.port, upgrade(path));
      await new Promise((r) => setTimeout(r, 200));
      return { series: (await fetch(`http://127.0.0.1:${d.port}/series`)).status };
    });
    console.log('  FACTS #1261 upgrade:', JSON.stringify({ requests: 4, uncaught: got.thrown.length, kinds: [...new Set(got.thrown)], seriesAfter: got.series }));
    assert.equal(got.thrown.length, 0, `an upgrade path that is no URL threw in the seat: ${got.thrown[0]}`);
    assert.equal(got.series, 200);
  } finally { await d.close(); }
});

test('#1261 a client that resets the /gateway proxy mid-body, or while the answer streams back, closes that request; the seat answers on', async () => {
  // a gatewayd that reads slowly and answers slowly, in chunks
  const gw = createServer((req, res) => { req.on('data', () => {}); req.on('error', () => {}); res.on('error', () => {});
    res.writeHead(200, { 'content-type': 'text/plain' }); let n = 0; const t = setInterval(() => { if (n++ > 20 || res.destroyed) { clearInterval(t); try { res.end(); } catch { /* gone */ } return; } try { res.write('x'.repeat(1024)); } catch { /* gone */ } }, 20); });
  await new Promise((r) => gw.listen(0, '127.0.0.1', r));
  const before = process.env.ARENA_GATEWAY_PORT;
  process.env.ARENA_GATEWAY_PORT = String(gw.address().port);
  const d = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, funded: () => true });
  try {
    const got = await watched(async () => {
      for (let i = 0; i < 10; i++) {
        await raw(d.port, `POST /gateway/x HTTP/1.1\r\nHost: x\r\nContent-Length: 1000000\r\n\r\n${'y'.repeat(2000)}`, { resetAfterMs: 30 });   // mid-body
        await raw(d.port, 'GET /gateway/x HTTP/1.1\r\nHost: x\r\n\r\n', { resetAfterMs: 90 });                                                      // while it streams back
      }
      await new Promise((r) => setTimeout(r, 300));
      return { series: (await fetch(`http://127.0.0.1:${d.port}/series`)).status };
    });
    console.log('  FACTS #1261 gateway:', JSON.stringify({ resets: 20, uncaught: got.thrown.length, kinds: [...new Set(got.thrown)], seriesAfter: got.series }));
    assert.equal(got.thrown.length, 0, `a reset on the gateway proxy threw in the seat: ${got.thrown[0]}`);
    assert.equal(got.series, 200);
  } finally {
    if (before === undefined) delete process.env.ARENA_GATEWAY_PORT; else process.env.ARENA_GATEWAY_PORT = before;
    await d.close(); await new Promise((r) => gw.close(r));
  }
});
