// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 a44 refute of #1632: the fix capped a peer's GET /entry-void in verify.js (#equivocationProven) at 4096
// bytes, but server.js lateByPeers reads THE SAME DOOR with a bare fetch + r.json() - no cap. It runs on any /play
// socket message that carries a first mark this seat does not hold (a stranger's made-up one for the real round is
// enough: no stake check for an entry the seat does not know). One peer answering a large JSON body parses on the seat's
// one thread. Safe: the seat's thread is not held for seconds by one peer's /entry-void answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { ed25519 } from '@noble/curves/ed25519.js';
import { lockPort } from './lock-fixture.js';
import { lockRound } from './lock-round-fixture.js';
import { wait, say } from './window-fixture.js';
import { encodeCheckpoint, joinSigned } from '../../arena-protocol/src/checkpoint.js';

test('#1489-a44-refute-38-s1-1 (kanban #2163): one peer\'s padded /entry-void answer read by lateByPeers does not hold the seat\'s thread', async () => {
  const UNITS = 40_000_000;
  const body = Buffer.from('{"firstMark":null,"pad":[' + '[],'.repeat(UNITS) + '[]]}');
  let asked = 0;
  const evil = createServer((req, res) => {
    if (req.url.startsWith('/entry-void')) { asked++; res.writeHead(200, { 'content-type': 'application/json' }); return res.end(body); }
    res.writeHead(404); return res.end('no');
  });
  await new Promise((r) => evil.listen(0, '127.0.0.1', r));
  const port = lockPort();
  const w = await lockRound({ port });
  try {
    w.a.verifier.peers = [`http://127.0.0.1:${evil.address().port}`, ...w.a.verifier.peers];
    // a stranger's made-up first mark of the real round, for an entry the seat does not know
    const k = ed25519.utils.randomSecretKey();
    const c = { roundId: w.rid, entryId: new Uint8Array(32).fill(9), tick: 0, stateHash: new Uint8Array(32).fill(3),
      inputChainHash: new Uint8Array(32), previousHash: new Uint8Array(32) };
    const enc = encodeCheckpoint(c);
    const mark = joinSigned(enc, ed25519.sign(enc, k));
    let last = Date.now(); let worst = 0;
    const tick = setInterval(() => { const now = Date.now(); worst = Math.max(worst, now - last); last = now; }, 20);
    const t0 = Date.now();
    const answer = await Promise.race([say(w.a.port, mark), wait(20000).then(() => 'no answer')]);
    const took = Date.now() - t0;
    clearInterval(tick);
    console.log('  FACTS:', JSON.stringify({ bodyBytes: body.length, asked, answer: String(answer).slice(0, 80), tookMs: took, worstLoopGapMs: worst }));
    assert.ok(asked > 0, 'lateByPeers never asked the peer');
    assert.ok(worst < 2000, `one peer's ${body.length}-byte /entry-void answer held the seat's thread ${worst} ms (lateByPeers, server.js)`);
  } finally {
    evil.closeAllConnections(); evil.close();
    await Promise.race([w.close(), wait(5000)]);
  }
});
