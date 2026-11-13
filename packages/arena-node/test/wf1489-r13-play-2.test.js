// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 round 13 (play path): ONE SEAT TURNS AN HONEST STUCK PAGE'S REFUSED MARK INTO A "RECEIPTED" FORK AT EVERY SEAT.
// RULED 2026-10-05 (b): two chains from one parent forfeit only when BOTH marks were receipted - a stale-head mark every seat
// refused "was never carried, splits no seats, and costs the player nothing" (equivocation-fork.test.js (h)). verify.js
// #forkFromPeers takes every mark in a peer's GET /checkpoints answer as "the peer's receipted chain" and keeps a same-parent
// pair with `receipted: true` on that peer's word alone - no receipt of it is asked for or checked. The stuck page sent its
// refused stale mark to every seat, so one seat (or anyone who read it from a seat's public /equivocation) holds the player's
// signed bytes: that seat lists the refused mark in its /checkpoints answer, and the honest seat signs the winner FORFEIT 0.
// Safe: a peer's listed mark counts as receipted only when it carries a committee receipt this seat verifies; the honest
// stuck page is signed as ever.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { lockRound, lockAndPlay, closeRound } from './lock-round-fixture.js';
import { b32, WINNER, wait } from './window-fixture.js';
import { splitSignedResult, decodePlayerResult } from '../../arena-protocol/src/result.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const STUCK = { name: 'stuck', key: b32(9), worldSecret: b32(0xc3), ticks: 1000 };
const resultsAt = (d, w, eid) => [...new Set(d.round.results(w.rid, eid).map((r) => { const x = decodePlayerResult(splitSignedResult(r.bytes).body); return `${x.outcome}/${x.score}`; }))];
// what seat d signed ITSELF (its own key), not the peers' results it gathered
const ownAt = (d, w, eid) => d.round.results(w.rid, eid).filter((r) => toHex(r.nodePubkey) === toHex(d.round.pubkey))
  .map((r) => { const x = decodePlayerResult(splitSignedResult(r.bytes).body); return `${x.outcome}/${x.score}`; });

test('#1489-r13-play-2: one seat listing a refused stale-head mark in its /checkpoints does not forfeit an honest stuck page', async () => {
  const w = await lockRound();
  let extra = null;
  const evil = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const c of req) chunks.push(c);
      const r = await fetch(`http://127.0.0.1:${w.b.port}${req.url}`, { method: req.method, body: chunks.length ? Buffer.concat(chunks) : undefined });
      let body = Buffer.from(await r.arrayBuffer());
      if (req.url.startsWith('/checkpoints') && extra && r.status === 200) body = Buffer.concat([body, extra]);
      res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/octet-stream' });
      res.end(body);
    } catch (e) { res.writeHead(502); res.end(String(e.message)); }
  });
  await new Promise((r) => evil.listen(0, '127.0.0.1', r));
  try {
    const won = await lockAndPlay(w, WINNER, { address: true });
    const stuck = await lockAndPlay(w, STUCK, { fork: 'stale' });
    assert.ok(stuck.forked.staleAnswers.every((a) => /does not follow the chain head/.test(a)), 'the stale mark was refused at every seat');
    // SEAT B'S COPY OF THE REFUSED STALE MARK (kept as an offered mark, public at its /equivocation), listed as if receipted
    const onPaper = w.b.round.equivocation(w.rid, stuck.eid);
    assert.ok(onPaper.length >= 1, 'seat B keeps the refused stale mark');
    extra = Buffer.from(onPaper[0].offered);
    w.a.verifier.peers = [`http://127.0.0.1:${evil.address().port}`];
    await closeRound(w);
    for (const stop = Date.now() + 20000; Date.now() < stop && !ownAt(w.a, w, stuck.eid).length; await wait(200));
    const facts = { aOwn: ownAt(w.a, w, stuck.eid), bOwn: ownAt(w.b, w, stuck.eid), heldAtA: resultsAt(w.a, w, stuck.eid), aProvenFork: w.a.round.provenFork(w.rid, stuck.eid) };
    console.log('  FACTS:', JSON.stringify(facts));
    assert.equal(facts.aOwn.length, 1, 'seat A signed nothing for the stuck page');
    assert.doesNotMatch(facts.aOwn[0], /^FORFEIT/, 'one seat\'s /checkpoints listing of a refused stale mark made seat A forfeit an honest stuck page');
    assert.equal(facts.aProvenFork, null);
    assert.ok(won);
  } finally {
    evil.closeAllConnections(); evil.close();
    await Promise.race([w.close(), wait(5000)]);
  }
});
