// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Audit 2026-11-19 play r1 #1 (P11, gap in #2550's fix): #forkFromPeers skips a peer-listed same-parent mark only when THIS seat
// kept it in offered_marks (round.refusedOfferedMark). keepOffered stops writing after OFFERED_KEEP + OFFERED_PROOF_KEEP (64 + 8)
// refused marks of one entry. A page stuck on an old head for more than 72 marks (63 measured live) has its later stale marks
// refused at every seat WITHOUT a row - and one seat that lists one of those in its GET /checkpoints again makes the honest seat
// sign the honest stuck page FORFEIT 0 (the #2550 attack, past the cap).
// Safe: a mark this seat refused as not following the chain head is no receipted limb, whether or not its row was kept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { ed25519 } from '@noble/curves/ed25519.js';
import { lockRound, lockAndPlay, closeRound } from './lock-round-fixture.js';
import { b32, WINNER, wait } from './window-fixture.js';
import { splitSignedResult, decodePlayerResult } from '../../arena-protocol/src/result.js';
import { toHex, sha256 } from '../../arena-protocol/src/hash.js';
import { encodeCheckpoint, joinSigned, checkpointId, splitSigned, decodeCheckpoint } from '../../arena-protocol/src/checkpoint.js';

const N = 80;
const STUCK = { name: 'stuck', key: b32(9), worldSecret: b32(0xc3), ticks: 1000 };
const ownAt = (d, w, eid) => d.round.results(w.rid, eid).filter((r) => toHex(r.nodePubkey) === toHex(d.round.pubkey))
  .map((r) => { const x = decodePlayerResult(splitSignedResult(r.bytes).body); return `${x.outcome}/${x.score}`; });

test('audit-play-r1-1: a stuck page past the offered_marks cap is not forfeited by one seat listing its later stale mark', async () => {
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
    const stuck = await lockAndPlay(w, STUCK, { fork: 'stale', staleMarks: N });
    assert.ok(stuck.forked.staleAnswers.every((a) => /does not follow the chain head/.test(a)), 'every stale mark was refused at every seat');
    // the stuck page's last stale mark (k = N - 1), as the fixture signed and sent it to both seats
    const s = decodeCheckpoint(splitSigned(stuck.forked.x).body);
    const last = { ...s, stateHash: sha256(Uint8Array.of(N - 1, ...s.stateHash)) };
    const lastBytes = joinSigned(encodeCheckpoint(last), ed25519.sign(checkpointId(last), stuck.session));
    // the evidence table's cap (kanban #3013: refusedOfferedMark now also reads the refused ids, so the precondition reads offered_marks itself)
    const keptAtA = !!w.a.round.db.prepare('SELECT 1 FROM offered_marks WHERE checkpoint_id = ?').get(checkpointId(last));
    console.log('  PRE:', JSON.stringify({ offeredAtA: w.a.round.offeredMarks(w.rid, stuck.eid).length, lastKeptAtA: keptAtA }));
    assert.equal(keptAtA, false, 'precondition: seat A refused the last stale mark without keeping it (cap)');
    extra = Buffer.from(lastBytes);
    w.a.verifier.peers = [`http://127.0.0.1:${evil.address().port}`];
    await closeRound(w);
    for (const stop = Date.now() + 20000; Date.now() < stop && !ownAt(w.a, w, stuck.eid).length; await wait(200));
    const facts = { aOwn: ownAt(w.a, w, stuck.eid), bOwn: ownAt(w.b, w, stuck.eid), aProvenFork: w.a.round.provenFork(w.rid, stuck.eid) };
    console.log('  FACTS:', JSON.stringify(facts));
    assert.equal(facts.aOwn.length, 1, 'seat A signed nothing for the stuck page');
    assert.doesNotMatch(facts.aOwn[0], /^FORFEIT/, 'one seat\'s /checkpoints listing of a refused (unkept) stale mark made seat A forfeit an honest stuck page');
    assert.equal(facts.aProvenFork, null);
    assert.ok(won);
  } finally {
    evil.closeAllConnections(); evil.close();
    await Promise.race([w.close(), wait(5000)]);
  }
});

