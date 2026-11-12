// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 round 4 (play path): ONE PEER'S GET /equivocation ANSWER IS READ WHOLE AND EVERY PAIR IN IT IS VERIFIED ON
// THE SEAT'S ONE THREAD. verify.js #equivocationProven - run at every played run's close, and on any stranger's
// POST /proof-pull - reads each peer's /equivocation with a bare fetch + arrayBuffer (no size cap, unlike #1550's
// peerBody) and checks every 462-byte pair it finds with provesEquivocation (an ed25519 verify each), one after another,
// with no limit on how many. One seat (or anything in the peer list) answering thousands of made-up "same tick" pairs
// of a real entry holds the honest seat's event loop for many seconds per pull - every /play frame, every batch and mark
// of every player waits. Safe: a peer's /equivocation answer is bounded (a fork needs one pair), so a pull costs the seat
// at most a moment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { ed25519 } from '@noble/curves/ed25519.js';
import { lockPort } from './lock-fixture.js';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { WINNER, wait } from './window-fixture.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { encodeCheckpoint, joinSigned } from '../../arena-protocol/src/checkpoint.js';

test('#1489-r4-play-1: one peer\'s padded /equivocation answer does not hold an honest seat\'s thread', async () => {
  let body = null;
  const evil = createServer((req, res) => {
    if (req.url.startsWith('/equivocation') && body) { res.writeHead(200, { 'content-type': 'application/octet-stream' }); return res.end(body); }
    if (req.url.startsWith('/receipts')) { res.writeHead(200, { 'content-type': 'application/octet-stream' }); return res.end(Buffer.alloc(0)); }
    res.writeHead(404); return res.end('no');
  });
  await new Promise((r) => evil.listen(0, '127.0.0.1', r));
  const port = lockPort();
  const w = await lockRound({ port });
  try {
    w.a.verifier.peers = [...w.a.verifier.peers, `http://127.0.0.1:${evil.address().port}`];
    const won = await lockAndPlay(w, WINNER);
    // made-up pairs of the REAL entry: same tick, different state hash, one well-formed signature (not the player's)
    const k = ed25519.utils.randomSecretKey();
    const sig = ed25519.sign(new Uint8Array(32).fill(7), k);
    const PAIRS = 6000;
    const parts = [];
    for (let i = 0; i < PAIRS; i++) {
      for (const side of [0, 1]) {
        const stateHash = new Uint8Array(32); stateHash[0] = side; stateHash[1] = i & 0xff; stateHash[2] = (i >> 8) & 0xff;
        const c = { roundId: w.rid, entryId: won.eid, tick: 5, stateHash, inputChainHash: new Uint8Array(32), previousHash: new Uint8Array(32).fill(1) };
        parts.push(Buffer.from(joinSigned(encodeCheckpoint(c), sig)));
      }
    }
    body = Buffer.concat(parts);
    // the seat's thread: the longest gap between ticks of a 20 ms interval while a stranger asks for one proof pull
    let last = Date.now(); let worst = 0;
    const tick = setInterval(() => { const now = Date.now(); worst = Math.max(worst, now - last); last = now; }, 20);
    const t0 = Date.now();
    const r = await fetch(`http://127.0.0.1:${w.a.port}/proof-pull?round=${toHex(w.rid)}&entry=${toHex(won.eid)}`, { method: 'POST' });
    const answered = await r.text();
    const took = Date.now() - t0;
    clearInterval(tick);
    const facts = { pairs: PAIRS, bodyBytes: body.length, answered, tookMs: took, worstLoopGapMs: worst };
    console.log('  FACTS:', JSON.stringify(facts));
    assert.ok(worst < 2000, `one peer's ${PAIRS} made-up /equivocation pairs held the seat's thread ${worst} ms in one pull (${took} ms in all)`);
  } finally {
    evil.closeAllConnections(); evil.close();
    await Promise.race([w.close(), wait(5000)]);
  }
});
