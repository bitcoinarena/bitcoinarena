// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 round 2 (play path): ONE PEER THAT TRICKLES ITS GET /checkpoints ANSWER HOLDS EVERY RUN'S SIGNATURE.
// Before a played run is signed, the close looks for a fork sent to different seats (verify.js #forkFromPeers): it reads
// every peer's GET /checkpoints with a bare fetch - no timeout, no size cap - one peer after another, and awaits each.
// A seat (or anything in the peer list) that answers 200 and sends a byte now and then never lets that await end, so the
// honest seat signs no result for any run of the round (the /receipts and /equivocation pulls before it are answered
// promptly here, so this is not the known #1489 r1 /receipts stall). Safe: a peer that does not answer in time proves
// nothing and the run is signed as ever.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { lockPort } from './lock-fixture.js';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { WINNER, wait, say } from './window-fixture.js';
import { toHex } from '../../arena-protocol/src/hash.js';

test('#1489-r2-play-4: one peer trickling its /checkpoints answer does not keep an honest seat from signing a played run', async () => {
  const timers = new Set();
  const evil = createServer((req, res) => {
    if (req.url.startsWith('/receipts')) { res.writeHead(200, { 'content-type': 'application/octet-stream' }); return res.end(Buffer.alloc(0)); }
    if (req.url.startsWith('/equivocation')) { res.writeHead(204); return res.end(); }
    if (req.url.startsWith('/checkpoints')) {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      const t = setInterval(() => { try { res.write(Buffer.from([0])); } catch { /* gone */ } }, 2000);
      timers.add(t); req.on('close', () => clearInterval(t));
      return undefined;
    }
    res.writeHead(404); return res.end('no');
  });
  await new Promise((r) => evil.listen(0, '127.0.0.1', r));
  const port = lockPort();
  const w = await lockRound({ port });
  try {
    w.a.verifier.peers = [...w.a.verifier.peers, `http://127.0.0.1:${evil.address().port}`];
    const won = await lockAndPlay(w, WINNER);
    await Promise.all([w.a, w.b].map((d) => say(d.port, `close ${toHex(w.rid)}`)));
    const signed = (d) => d.round.results(w.rid, won.eid).filter((r) => toHex(r.nodePubkey) === toHex(d.round.pubkey)).length;
    for (const stop = Date.now() + 30000; Date.now() < stop && !(signed(w.a) && signed(w.b)); await wait(250));
    const facts = { aSigned: signed(w.a), bSigned: signed(w.b) };
    console.log('  FACTS:', JSON.stringify(facts));
    assert.equal(facts.bSigned, 1, 'the control seat (no bad peer) did not sign');
    assert.equal(facts.aSigned, 1, 'one peer trickling /checkpoints kept the honest seat from signing the played run');
  } finally {
    for (const t of timers) clearInterval(t);
    evil.closeAllConnections(); evil.close();
    await Promise.race([w.close(), wait(5000)]);
  }
});
