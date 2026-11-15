// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r4 gossip-3 (P5, a bypass of #2637 / #1469): ONE COMMITTEE SEAT'S GET /lock-set ANSWER IS READ WHOLE BY EVERY HONEST SEAT.
// lock-set-book.js #pullOne reads a peer's /lock-set with `await r.text()` and only then checks `text.length > 262144`. Its fetch is the
// module's own global fetch (server.js builds the LockSetBook with no fetchFn), so #2637's answersUpTo cap - which sits only on server.js's
// fetch - does not apply: the whole body is buffered and turned into one string inside LOCK_SET_PEER_MS (2.5 s), on each pull (every
// LOCK_SET_PULL_MS = 150 ms per peer from a protocol-28 round's close to close + window + 2 s, again in lockOut and settle). One seat of the
// committee streaming hundreds of MB at each of those pulls holds that much (twice: chunks + string) on every honest seat at once.
// Safe behaviour: a pull of /lock-set reads at most about its 256 KiB bound and drops the rest of the stream.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { LockSetBook } from '../src/lock-set-book.js';

const TOTAL = 96 * 1048576;   // what the dishonest seat offers
const CHUNK = Buffer.alloc(1048576, 0x20);

test('wf1489 r4 gossip-3: one seat\'s padded GET /lock-set answer is not read whole by an honest seat', async () => {
  let sent = 0, closed = false;
  const evil = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"views":[],"pad":"');
    const more = () => {
      while (sent < TOTAL) {
        sent += CHUNK.length;
        if (!res.write(CHUNK)) { res.once('drain', more); return; }
      }
      res.end('"}');
    };
    res.on('close', () => { closed = true; });
    more();
  });
  await new Promise((ok) => evil.listen(0, '127.0.0.1', ok));
  const peer = `http://127.0.0.1:${evil.address().port}`;
  const secret = new Uint8Array(randomBytes(32)), pubkey = schnorr.getPublicKey(secret);
  const other = schnorr.getPublicKey(new Uint8Array(randomBytes(32)));
  const CLOSE = Date.now() - 100;
  const round = { db: new DatabaseSync(':memory:'), signerNodes: () => [pubkey, other], now: () => Date.now(), pubkey, identity: { secret, pubkey } };
  const book = new LockSetBook({ round, peersOf: () => [peer], roundOf: () => ({ entryCloseMs: BigInt(CLOSE), stakeMsat: 1000n }), viewOf: () => [] });
  const rid = new Uint8Array(randomBytes(32));
  const heapBefore = process.memoryUsage().arrayBuffers + process.memoryUsage().heapUsed;
  let peak = 0;
  const watch = setInterval(() => { const m = process.memoryUsage(); peak = Math.max(peak, m.arrayBuffers + m.heapUsed - heapBefore); }, 5);
  const t0 = Date.now();
  await book.pull(rid);
  const ms = Date.now() - t0;
  await new Promise((ok) => setTimeout(ok, 300));
  clearInterval(watch);
  evil.closeAllConnections?.(); evil.close();
  console.log('  FACTS (r4 gossip-3):', JSON.stringify({ sentMiB: +(sent / 1048576).toFixed(1), streamClosedByReader: closed, pullMs: ms, peakHeldMiB: +(peak / 1048576).toFixed(1) }));
  assert.ok(sent <= 16 * 1048576, `the honest seat read ${(sent / 1048576).toFixed(1)} MiB of one peer's /lock-set answer (bound: 256 KiB) - held ${(peak / 1048576).toFixed(1)} MiB at the peak`);
});
