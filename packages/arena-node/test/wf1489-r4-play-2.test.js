// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 round 4 (play path): ONE PEER'S GET /results ANSWER IS READ WHOLE AND EVERY RECORD IN IT IS SCHNORR-VERIFIED
// ON THE SEAT'S ONE THREAD. verify.js #gather - run after every played run's close, for every entry, peer after peer -
// reads each peer's /results with fetch + arrayBuffer (no size cap, unlike #1550's peerBody) and hands every record that
// names the round, the entry's player and a committee key to schnorr.verify, inside one synchronous `timed` block. One
// seat (or anything in the peer list) answering thousands of copies of a committee member's result with a bad signature
// holds the honest seat's event loop for seconds per entry - every /play frame of every player waits, and the next
// entry's gather after it. Safe: a peer's /results answer is bounded (one result per committee key is all it can add).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { lockPort } from './lock-fixture.js';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { WINNER, wait, say } from './window-fixture.js';
import { toHex } from '../../arena-protocol/src/hash.js';

test('#1489-r4-play-2: one peer\'s padded /results answer does not hold an honest seat\'s thread', async () => {
  let body = null;
  const evil = createServer((req, res) => {
    if (req.url.startsWith('/results') && body) { res.writeHead(200, { 'content-type': 'application/octet-stream' }); return res.end(body); }
    if (req.url.startsWith('/receipts')) { res.writeHead(200, { 'content-type': 'application/octet-stream' }); return res.end(Buffer.alloc(0)); }
    if (req.url.startsWith('/equivocation')) { res.writeHead(204); return res.end(); }
    res.writeHead(404); return res.end('no');
  });
  await new Promise((r) => evil.listen(0, '127.0.0.1', r));
  const port = lockPort();
  const w = await lockRound({ port });
  try {
    const won = await lockAndPlay(w, WINNER);
    await Promise.all([w.a, w.b].map((d) => say(d.port, `close ${toHex(w.rid)}`)));
    const mine = (d) => d.round.results(w.rid, won.eid).filter((r) => toHex(r.nodePubkey) === toHex(d.round.pubkey));
    for (const stop = Date.now() + 30000; Date.now() < stop && !(mine(w.a).length && mine(w.b).length); await wait(250));
    assert.ok(mine(w.b).length, 'seat B signed no result to copy');
    // seat B's own record (a committee key, this round, this player) with one byte of its signature changed, many times
    const real = Buffer.from(mine(w.b)[0].bytes);
    const bad = Buffer.from(real); bad[bad.length - 5] ^= 0x01;
    const COPIES = 4000;
    body = Buffer.concat(Array.from({ length: COPIES }, () => bad));
    w.a.verifier.peers = [`http://127.0.0.1:${evil.address().port}`, ...w.a.verifier.peers];
    let last = Date.now(); let worst = 0;
    const tick = setInterval(() => { const now = Date.now(); worst = Math.max(worst, now - last); last = now; }, 20);
    const t0 = Date.now();
    const g = await w.a.verifier.gather(w.rid, won.eid);
    const took = Date.now() - t0;
    clearInterval(tick);
    const facts = { copies: COPIES, bodyBytes: body.length, fetched: g.fetched, kept: g.kept, tookMs: took, worstLoopGapMs: worst };
    console.log('  FACTS:', JSON.stringify(facts));
    assert.ok(worst < 2000, `one peer's ${COPIES} padded /results records held the seat's thread ${worst} ms in one gather (${took} ms in all)`);
  } finally {
    evil.closeAllConnections(); evil.close();
    await Promise.race([w.close(), wait(5000)]);
  }
});
