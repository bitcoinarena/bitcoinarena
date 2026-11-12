// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 v1-refute-53 (bypass of #1550): #1550 says "every peer pull in verify.js has a deadline and a size cap",
// but the pre-sign /equivocation pull (#equivocationProven, right before #forkFromPeers) still reads the peer's body with
// a bare arrayBuffer() - no cap. One peer answering /equivocation with 256 MiB as fast as it can is read whole (and
// sliced again into pairs): the honest seat's memory jumps by ~1.7 GiB on one request, and its signature of the played
// run comes ~20 s late instead of ~0. Same for /late-first-mark, /entry-void (r.json), /results.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { lockPort } from './lock-fixture.js';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { WINNER, wait, say } from './window-fixture.js';
import { toHex } from '../../arena-protocol/src/hash.js';

test('#1489-v1-refute-53-1: a peer flooding its /equivocation answer is capped like /checkpoints', async () => {
  let taken = 0;
  const evil = createServer((req, res) => {
    if (req.url.startsWith('/receipts')) { res.writeHead(200, { 'content-type': 'application/octet-stream' }); return res.end(Buffer.alloc(0)); }
    if (req.url.startsWith('/equivocation')) {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      const chunk = Buffer.alloc(1 << 20, 0x20); let closed = false; let sent = 0;
      res.on('close', () => { closed = true; });
      const pump = () => {
        while (!closed && sent < 256) {
          sent++; if (!res.write(chunk, (err) => { if (!err) taken += chunk.length; })) { res.once('drain', pump); return; }
        }
        if (!closed) res.end();
      };
      pump();
      return undefined;
    }
    res.writeHead(404); return res.end('no');
  });
  await new Promise((r) => evil.listen(0, '127.0.0.1', r));
  const port = lockPort();
  const w = await lockRound({ port });
  const rss0 = process.memoryUsage().rss; let peak = rss0;
  const memT = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 50);
  try {
    const won = await lockAndPlay(w, WINNER);
    w.a.verifier.peers = [...w.a.verifier.peers, `http://127.0.0.1:${evil.address().port}`];
    const t0 = Date.now();
    await Promise.all([w.a, w.b].map((d) => say(d.port, `close ${toHex(w.rid)}`)));
    const signed = (d) => d.round.results(w.rid, won.eid).filter((r) => toHex(r.nodePubkey) === toHex(d.round.pubkey)).length;
    for (const stop = Date.now() + 30000; Date.now() < stop && !(signed(w.a) && signed(w.b)); await wait(250));
    const facts = { aSigned: signed(w.a), bSigned: signed(w.b), aMs: Date.now() - t0, takenMiB: taken / 1048576, peakRssDeltaMiB: Math.round((peak - rss0) / 1048576) };
    console.log('  FACTS:', JSON.stringify(facts));
    assert.equal(facts.bSigned, 1, 'the control seat did not sign');
    assert.equal(facts.aSigned, 1, 'the seat with the flooding peer did not sign');
    assert.ok(taken <= 32 * 1048576, `the honest seat read ${facts.takenMiB} MiB of one peer's /equivocation (no 16 MiB cap; RSS +${facts.peakRssDeltaMiB} MiB)`);
  } finally {
    clearInterval(memT);
    evil.closeAllConnections(); evil.close();
    await Promise.race([w.close(), wait(5000)]);
  }
});
