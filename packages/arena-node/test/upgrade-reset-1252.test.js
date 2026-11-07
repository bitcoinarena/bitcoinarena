// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1252: "throw er; // Unhandled 'error' event ... read ECONNRESET ... on Socket instance" ended seats on the old Mac (fed B seat 3 at its audit15
// start, 2026-11-07 04:48Z, and 8 times on seats 5-7 before): an upgraded socket gets no error listener from Node, and a peer's reset on it ended the node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { HOSTED } from './plugins/hosted.js';

const resetUpgrade = (port, path) => new Promise((done) => {
  const s = connect({ host: '127.0.0.1', port }, () => {
    s.write(`GET ${path} HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`);
    setTimeout(() => { s.resetAndDestroy(); done(); }, 30);
  });
  s.on('error', () => done());
});

test('#1252 an upgrade the client resets - to a path the seat does not carry, or mid-handshake - closes that socket, never throws in the seat', async () => {
  const d = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, funded: () => true });
  const thrown = []; const catcher = (e) => thrown.push(String(e && e.code || e));
  process.on('uncaughtException', catcher);
  try {
    for (let i = 0; i < 20; i++) { await resetUpgrade(d.port, '/guardian-api/nobody'); await resetUpgrade(d.port, '/play'); await resetUpgrade(d.port, '/guardian'); }
    await new Promise((r) => setTimeout(r, 200));
    const series = (await fetch(`http://127.0.0.1:${d.port}/series`)).status;
    console.log('  MEASURED #1252:', JSON.stringify({ resets: 60, uncaught: thrown.length, kinds: [...new Set(thrown)], seriesAfter: series }));
    assert.equal(thrown.length, 0, `a reset upgraded socket threw in the seat: ${thrown[0]}`);
    assert.equal(series, 200);
  } finally { process.off('uncaughtException', catcher); await d.close(); }
});
