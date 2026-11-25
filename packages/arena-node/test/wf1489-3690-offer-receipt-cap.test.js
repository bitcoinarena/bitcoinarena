// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3690 (#1489 bypass of #1469, every body has a limit): offerReceipt dials each round peer's /play and reads its answer with no
// message cap - outside wsMessages and the body budget. A peer answering a receipt offer with one 48 MiB frame had it read whole.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { offerReceiptTo } from '../src/server.js';

const SENT = 48 * 1024 * 1024;   // an honest answer to a receipt offer is a frame of a few hundred bytes

test('#3690: a round peer\'s answer to a receipt offer is read up to a cap, not whole', async () => {
  const http = createServer();
  const wss = new WebSocketServer({ server: http, path: '/play' });
  const closed = new Promise((ok) => wss.on('connection', (sock) => {
    let sent = false;
    sock.on('message', () => sock.send(Buffer.alloc(SENT, 0x61), () => { sent = true; }));
    sock.on('error', () => {});
    sock.on('close', (code) => ok({ code, sentWhole: sent }));
  }));
  await new Promise((ok) => http.listen(0, '127.0.0.1', ok));
  const rss0 = process.memoryUsage().rss;
  try {
    const ws = offerReceiptTo(`http://127.0.0.1:${http.address().port}`, new Uint8Array([1, 2, 3]), { timeoutMs: 20000 });
    let longest = 0;
    ws.addEventListener('message', (ev) => { longest = Math.max(longest, ev.data.byteLength ?? ev.data.length ?? 0); });
    const ended = new Promise((ok) => ws.addEventListener('close', ok));
    const got = await closed; await ended;
    console.log('#3690 FACTS:', JSON.stringify({ ...got, answerBytesRead: longest, sentBytes: SENT, rssGrowthMB: Math.round((process.memoryUsage().rss - rss0) / 1048576) }));
    assert.ok(longest <= 64 * 1024, `the dialing seat read the peer's ${longest}-byte answer whole (an honest one is a few hundred bytes)`);
  } finally { for (const c of wss.clients) c.terminate(); wss.close(); http.closeAllConnections?.(); await new Promise((ok) => http.close(ok)); }
});

test('#3690: an honest peer gets the receipt and its short answer is read', async () => {
  const http = createServer();
  const wss = new WebSocketServer({ server: http, path: '/play' });
  const heard = new Promise((ok) => wss.on('connection', (sock) => {
    sock.on('message', (m) => { sock.send(Buffer.alloc(300, 0x62)); ok(Buffer.from(m)); });
    sock.on('error', () => {});
  }));
  await new Promise((ok) => http.listen(0, '127.0.0.1', ok));
  try {
    const ws = offerReceiptTo(`http://127.0.0.1:${http.address().port}`, new Uint8Array([7, 8, 9]));
    let answer = 0;
    ws.addEventListener('message', (ev) => { answer = ev.data.byteLength; });
    const ended = new Promise((ok) => ws.addEventListener('close', (ev) => ok(ev.code)));
    assert.deepEqual([...(await heard)], [7, 8, 9]);
    assert.equal(await ended, 1005);
    assert.equal(answer, 300);
  } finally { wss.close(); http.closeAllConnections?.(); await new Promise((ok) => http.close(ok)); }
});
