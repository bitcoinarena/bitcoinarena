// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 r3 nostr-1 (kanban #1489): A RELAY THE PAYER NAMED IS READ WITHOUT A FRAME LIMIT.
// The zap address (tools/zap-address.mjs) sends every paid zap's receipt to the relays the payer's own zap request names
// (#2454 keeps only public wss:// hosts - any host the payer owns qualifies) through nostr-results.js sendToRelay, whose socket is
// `new WebSocket(url)` (and the tool's own connect, `new WebSocket(u, { lookup, followRedirects })`) - no maxPayload, so the ws
// default of 100 MiB per message applies. The payer's relay answers the EVENT with one huge frame: ws buffers it whole, sendToRelay
// turns it into a string (String(raw)) and JSON.parses it - ~3 copies of each frame live at once, per socket. The publish lanes run
// up to ZAP_PUBLISH_PARALLEL (32) sends at once (24 for hosts not proven, 2 per host - one payer names 8 hosts, several payers more),
// and a failed send is retried ZAP_PUBLISH_TRIES times: a few 1-sat zaps put gigabytes into the zap server and it dies (out of
// memory), with every honest receipt it still owed. The same function publishes every seat's round results and badges
// (ARENA_NOSTR_PUBLISH) - one relay there is one third party's word over the seat's memory.
// Safe behaviour: a relay's frame far larger than any NIP-01 answer (an OK, a NOTICE: a few hundred bytes) is refused before it is
// read - the socket is closed, no answer is taken from it, and the process does not hold the frame.
import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { sendToRelay } from '../src/nostr-results.js';

const MB = 1024 * 1024;

test('wf1489-r3-nostr-1: a relay answering with a 48 MiB frame is cut off, not read', async () => {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((r) => wss.on('listening', r));
  const huge = 'x'.repeat(48 * MB);
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(String(raw)); } catch { return; }
      if (m[0] === 'EVENT') ws.send(`["OK","${m[1].id}",true,"${huge}"]`);   // one frame: the OK the client waits for, padded
    });
    ws.on('error', () => {});
  });
  const url = `ws://127.0.0.1:${wss.address().port}`;
  const event = { id: 'ab'.repeat(32), kind: 9735, tags: [], content: '' };
  const base = process.memoryUsage();
  let peak = 0;
  const probe = setInterval(() => { const u = process.memoryUsage(); peak = Math.max(peak, (u.arrayBuffers - base.arrayBuffers) + (u.heapUsed - base.heapUsed)); }, 5);
  try {
    const answers = await sendToRelay(url, [event], { timeoutMs: 20000 });
    clearInterval(probe);
    const got = answers.get(event.id);
    assert.ok(got === undefined,
      `sendToRelay read the relay's whole ${48} MiB frame and took it as the answer (ok=${got && got.ok}, why ${got ? got.why.length : 0} chars); `
      + `about ${Math.round(peak / MB)} MiB held at the peak for ONE socket - the zap address runs up to 32 such sends at once`);
  } finally {
    clearInterval(probe);
    for (const c of wss.clients) c.terminate();
    await new Promise((r) => wss.close(r));
  }
});
