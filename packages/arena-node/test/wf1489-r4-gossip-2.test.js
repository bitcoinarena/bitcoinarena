// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r4 gossip-2 (P5, peer answers' sizes): ONE PEER'S GET /equivocation ANSWER COSTS AN HONEST SEAT ONE ED25519 VERIFY PER PAIR, WITHOUT BOUND.
// Before a played run is signed, verify.js #equivocationProven pulls every peer's /equivocation with a bare fetch + arrayBuffer (not the #1550 peerBody
// cap) and cuts it into pairs of signed marks; every distinct pair that names the entry's round, entry and one tick is handed to provesEquivocation,
// which runs a full session-key signature check on it - on the seat's main thread, in one loop with no yield to timers. A seat (or anything in the peer
// list) answering a few MB of such made-up pairs (any well-formed 64-byte signature) stops the honest seat's event loop for seconds per close, and
// again at every close and every forfeit/first-mark pull.
// Safe behaviour: a peer's /equivocation is bounded (bytes and pairs checked), so the honest seat's event loop is never held for seconds by it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { ed25519 } from '@noble/curves/ed25519.js';
import { lockPort } from './lock-fixture.js';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { WINNER, wait, say } from './window-fixture.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { encodeCheckpoint, SIGNED_CHECKPOINT_BYTES } from '../../arena-protocol/src/checkpoint.js';

const PAIRS = 6000;   // 6000 * 462 bytes = 2.8 MB, well under #1550's 16 MB peer cap

test('wf1489 r4 gossip-2: one peer\'s /equivocation of made-up pairs does not hold an honest seat\'s event loop for seconds', async () => {
  // one well-formed signature (R a curve point, S below L) by an unrelated key: it fails only after the whole verify
  const k = new Uint8Array(32).fill(7);
  const sig = ed25519.sign(new Uint8Array(32), k);
  let served = 0;
  const evil = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/receipts') { res.writeHead(200, { 'content-type': 'application/octet-stream' }); return res.end(Buffer.alloc(0)); }
    if (u.pathname === '/checkpoints') { res.writeHead(200, { 'content-type': 'application/octet-stream' }); return res.end(Buffer.alloc(0)); }
    if (u.pathname === '/equivocation') {
      const roundId = fromHex(u.searchParams.get('round')), entryId = fromHex(u.searchParams.get('entry'));
      const out = Buffer.alloc(PAIRS * 2 * SIGNED_CHECKPOINT_BYTES);
      for (let i = 0; i < PAIRS; i++) for (let j = 0; j < 2; j++) {
        const sh = new Uint8Array(32); sh[0] = j; sh[1] = i & 0xff; sh[2] = (i >> 8) & 0xff;
        const body = encodeCheckpoint({ roundId, entryId, tick: 1, stateHash: sh, inputChainHash: new Uint8Array(32), previousHash: new Uint8Array(32).fill(1) });
        const at = (2 * i + j) * SIGNED_CHECKPOINT_BYTES;
        out.set(body, at); out.set(sig, at + body.length);
      }
      served++;
      res.writeHead(200, { 'content-type': 'application/octet-stream' }); return res.end(out);
    }
    res.writeHead(404); return res.end('no');
  });
  await new Promise((r) => evil.listen(0, '127.0.0.1', r));
  const port = lockPort();
  const w = await lockRound({ port });
  // the honest seat's event loop, watched: the longest gap between two 50 ms timer ticks
  let last = Date.now(), worst = 0;
  const watch = setInterval(() => { const n = Date.now(); worst = Math.max(worst, n - last); last = n; }, 50);
  try {
    w.a.verifier.peers = [...w.a.verifier.peers, `http://127.0.0.1:${evil.address().port}`];
    const won = await lockAndPlay(w, WINNER);
    last = Date.now(); worst = 0;
    await Promise.all([w.a, w.b].map((d) => say(d.port, `close ${toHex(w.rid)}`)));
    const signed = (d) => d.round.results(w.rid, won.eid).filter((r) => toHex(r.nodePubkey) === toHex(d.round.pubkey)).length;
    for (const stop = Date.now() + 90000; Date.now() < stop && !(signed(w.a) && signed(w.b)); await wait(250));
    const facts = { served, aSigned: signed(w.a), bSigned: signed(w.b), worstLoopGapMs: worst };
    console.log('  FACTS:', JSON.stringify(facts));
    assert.ok(served > 0, 'the bad peer was never asked for /equivocation');
    assert.ok(worst < 2000, `one peer's /equivocation answer of ${PAIRS} made-up pairs (${(PAIRS * 2 * SIGNED_CHECKPOINT_BYTES / 1e6).toFixed(1)} MB) held the honest seat's event loop for ${worst} ms - a signature check per pair, without bound`);
  } finally {
    clearInterval(watch);
    evil.closeAllConnections(); evil.close();
    await Promise.race([w.close(), wait(5000)]);
  }
});
