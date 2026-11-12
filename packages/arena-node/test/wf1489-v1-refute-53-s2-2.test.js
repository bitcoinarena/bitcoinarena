// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 v1-refute-53-s2 (bypass of #1550 / #1744): the RETRY path after the close. #1744 put the close gather of
// /results through peerBody, but the FINAL-signature gather (server.js gatherFinal, run by the finality watch again and
// again until a run is FINAL) still reads every peer's /final-sig with a bare arrayBuffer() - no cap, 3 s to stream.
// A FINAL signature is one fixed-size record. One peer answering /final-sig with 192 MiB as fast as it can is read whole.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { lockPort } from './lock-fixture.js';
import { lockRound, lockAndPlay, closeRound } from './lock-round-fixture.js';
import { WINNER, wait } from './window-fixture.js';

const MIB = 1 << 20;
test('#1489-v1-refute-53-s2-2: a peer flooding /final-sig is read whole by the FINAL gather (retry path)', async () => {
  let taken = 0; let asked = 0;
  const evil = createServer((req, res) => {
    if (req.url.startsWith('/final-sig')) {
      asked++;
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      const chunk = Buffer.alloc(MIB, 0x20); let closed = false; let sent = 0;
      res.on('close', () => { closed = true; });
      const pump = () => {
        while (!closed && sent < 192) {
          sent++; if (!res.write(chunk, (err) => { if (!err) taken += chunk.length; })) { res.once('drain', pump); return; }
        }
        if (!closed) res.end();
      };
      pump();
      return undefined;
    }
    if (req.url.startsWith('/receipts')) { res.writeHead(200); return res.end(Buffer.alloc(0)); }
    res.writeHead(404); return res.end('no');
  });
  await new Promise((r) => evil.listen(0, '127.0.0.1', r));
  const port = lockPort();
  const w = await lockRound({ port });
  const rss0 = process.memoryUsage().rss; let peak = rss0;
  const memT = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 20);
  try {
    await lockAndPlay(w, WINNER);
    w.a.verifier.peers = [...w.a.verifier.peers, `http://127.0.0.1:${evil.address().port}`];
    await closeRound(w);
    for (const stop = Date.now() + 20000; Date.now() < stop && asked < 1; await wait(200));
    await wait(3500);
    const facts = { asked, takenMiB: Math.round(taken / MIB), peakRssDeltaMiB: Math.round((peak - rss0) / MIB) };
    console.log('  FACTS:', JSON.stringify(facts));
    assert.ok(asked >= 1, 'the FINAL gather never asked the peer (path not reached)');
    assert.ok(taken <= 4 * MIB, `the FINAL gather read ${facts.takenMiB} MiB of one peer's /final-sig over ${asked} ask(s) (no cap; RSS +${facts.peakRssDeltaMiB} MiB)`);
  } finally {
    clearInterval(memT);
    evil.closeAllConnections(); evil.close();
    await Promise.race([w.close(), wait(5000)]);
  }
});
