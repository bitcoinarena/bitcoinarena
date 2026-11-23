// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r4 gossip-5 (P5, a bypass of #2458 / #2637): A PEER'S REFUSAL IS READ WHOLE BY A MARKET'S BATCH LEADER.
// order-batch.js #ask caps an ok answer (jsonUpTo BODY_MOST, #2458) but reads a refused one with a bare `r.text()` - racing only the
// BATCH_FETCH_MS (1 s) deadline. OrderBook is built in server.js with no fetcher, so the module's global fetch is used and #2637's
// answersUpTo cap (server.js's fetch only) does not apply. Every leader of every batch (each BATCH_MS = 500 ms, each seat in turn) asks every
// peer GET /batch-proposal, then POSTs /batch, /batch-certificate, /batch-void-ask through #ask: one market seat answering 409 with a
// stream of hundreds of MB makes each leader buffer and stringify all it gets in that second, twice a batch, for every open market round.
// Safe behaviour: a refused answer's reason is read to a small bound (as #2084 caps the forfeit's), the rest of the stream dropped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { OrderBook } from '../src/order-batch.js';

const TOTAL = 96 * 1048576;
const CHUNK = Buffer.alloc(1048576, 0x61);

test('wf1489 r4 gossip-5: one seat\'s padded 409 to GET /batch-proposal is not read whole by the batch leader', async () => {
  let sent = 0, asked = 0;
  const evil = createServer((req, res) => {
    asked++;
    res.writeHead(409, { 'content-type': 'text/plain' });
    const more = () => {
      while (sent < TOTAL) { sent += CHUNK.length; if (!res.write(CHUNK)) { res.once('drain', more); return; } }
      res.end();
    };
    more();
  });
  await new Promise((ok) => evil.listen(0, '127.0.0.1', ok));
  const peer = `http://127.0.0.1:${evil.address().port}`;
  const secret = new Uint8Array(randomBytes(32));
  const round = { db: new DatabaseSync(':memory:'), pubkey: schnorr.getPublicKey(secret), identity: { secret }, now: () => Date.now() };
  const ob = new OrderBook(round, { plugins: [], peersFor: () => [peer] });
  // the round's market as the leader holds it (only what lead() reads before it asks its peers)
  ob.market = () => ({ ok: true, needed: 2, contract: { nodes: [round.pubkey, round.pubkey], entryCloseMs: BigInt(Date.now() + 3600000) } });
  ob.leads = () => true;
  const base = process.memoryUsage();
  let peak = 0;
  const w = setInterval(() => { const m = process.memoryUsage(); peak = Math.max(peak, m.arrayBuffers + m.heapUsed - base.arrayBuffers - base.heapUsed); }, 5);
  const t0 = Date.now();
  try { await ob.lead(new Uint8Array(randomBytes(32)), Math.floor(Date.now() / 500)); } catch { /* the stub market ends lead() after the ask */ }
  const ms = Date.now() - t0;
  clearInterval(w);
  evil.closeAllConnections?.(); evil.close();
  console.log('  FACTS (r4 gossip-5):', JSON.stringify({ asked, sentMiB: +(sent / 1048576).toFixed(1), leadMs: ms, peakHeldMiB: +(peak / 1048576).toFixed(1) }));
  assert.ok(asked >= 1, 'the leader never asked the peer - the variant did not run');
  assert.ok(sent <= 16 * 1048576, `the batch leader read ${(sent / 1048576).toFixed(1)} MiB of one seat's refusal - held ${(peak / 1048576).toFixed(1)} MiB at the peak`);
});
