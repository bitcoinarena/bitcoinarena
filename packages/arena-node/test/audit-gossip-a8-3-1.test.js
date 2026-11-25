// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Audit gossip a8 r3-1 (gap in #3690): relayMarks (relay.js) hands a checkpoint equivocation's two marks to every publication relay AND every
// round peer (relayTargets: the announced committee are relays too) over its /play socket - the very door #3690 capped for offerReceiptTo at
// OFFER_ANSWER_MOST (64 KiB). relayMarks dials with the 'ws' default maxPayload (100 MiB), and only counts that an answer came. One committee
// seat answering each mark with a 48 MiB frame has both read whole by every honest seat that relays an equivocation to it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { relayMarks } from '../src/relay.js';
// the cap relayMarks dials with: ws-dial.js PLAY_ANSWER_MOST, the same 64 KiB as #3690's OFFER_ANSWER_MOST (server.js on 2.0)
import { PLAY_ANSWER_MOST as OFFER_ANSWER_MOST } from '../src/ws-dial.js';

const SENT = 48 * 1024 * 1024;   // an honest relay's answer to a mark is a few hundred bytes

test('audit gossip a8-3-1: a relay peer\'s answer to a relayed mark is read up to a cap, not whole', async () => {
  const http = createServer();
  const wss = new WebSocketServer({ server: http, path: '/play' });
  let sentWhole = 0;
  wss.on('connection', (sock) => {
    sock.on('message', () => sock.send(Buffer.alloc(SENT, 0x61), (e) => { if (!e) sentWhole++; }));
    sock.on('error', () => {});
  });
  await new Promise((ok) => http.listen(0, '127.0.0.1', ok));
  const rss0 = process.memoryUsage().rss;
  try {
    const r = await relayMarks([`http://127.0.0.1:${http.address().port}`], [Uint8Array.from([0xaa]), Uint8Array.from([0xbb])], { timeoutMs: 20000 });
    console.log('a8-3-1 FACTS:', JSON.stringify({ ...r, sentWhole, sentBytesEach: SENT, cap: OFFER_ANSWER_MOST, rssGrowthMB: Math.round((process.memoryUsage().rss - rss0) / 1048576) }));
    assert.equal(r.sent, 0, `the relaying seat read the peer's ${SENT}-byte answers whole and counted the relay as answered (the #3690 cap is ${OFFER_ANSWER_MOST} bytes)`);
  } finally { for (const c of wss.clients) c.terminate(); wss.close(); http.closeAllConnections?.(); await new Promise((ok) => http.close(ok)); }
});
