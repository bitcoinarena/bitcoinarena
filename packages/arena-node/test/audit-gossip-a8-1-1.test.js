// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AUDIT gossip a8-1-1: the reserve read (federation-reserve.js readReserve -> askOne) dials each census guardian's endpoint with
// the process's global WebSocket (undici), which has no message cap, and reads whatever one guardian answers whole - the same hole
// #3690 closed for offerReceipt, left open on the reserve read every seat runs for GET /federation-record and the record gather.
// SAFE BEHAVIOUR: one guardian's 96 MiB answer is not read whole (its socket is cut at a small cap), and that guardian counts as
// no answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { readReserve } from '../src/federation-reserve.js';

const BIG = 96 * 1024 * 1024;

test('one guardian answering the reserve ask with a 96 MiB frame is not read whole', async () => {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((r) => wss.once('listening', r));
  const port = wss.address().port;
  let flushed = null, answered = false;
  wss.on('connection', (ws) => {
    ws.on('error', () => {});
    ws.once('message', () => {
      if (answered) return; answered = true;
      // one huge frame, then a valid summary: a reader with a cap never reaches the second one
      ws.send('x'.repeat(BIG), (err) => { flushed = !err; });
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 3, result: { spendable_utxos: [{ amount: 1000, outpoint: `${'00'.repeat(32)}:0` }], unconfirmed_change_utxos: [] } }));
    });
  });
  const before = process.memoryUsage().rss;
  const got = await readReserve({ endpoints: [`ws://127.0.0.1:${port}`], threshold: 1, timeoutMs: 8000, localOk: true });
  const grew = process.memoryUsage().rss - before;
  await new Promise((r) => setTimeout(r, 300));
  for (const c of wss.clients) c.terminate();
  await new Promise((r) => wss.close(r));
  console.log(`readReserve: ok=${got.ok} why=${got.why || ''} reserve=${got.reserveSats}; 96 MiB frame flushed to the reader: ${flushed}; rss +${Math.round(grew / 1048576)} MB`);
  assert.notEqual(flushed, true, 'the reader took the whole 96 MiB frame off the socket (no message cap on the reserve read)');
  assert.equal(got.ok, false, 'the guardian whose answer passed any sane cap was read on and counted');
});
