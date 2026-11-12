// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 round 4 (play path): ONE PEER'S GET /receipts ANSWER COSTS ONE SCHNORR VERIFY PER RECORD, UP TO #1550's
// 16 MB, IN ONE SYNCHRONOUS BLOCK. verify.js carryReceipts - every close, every retryClose, for every entry, peer after
// peer - takes each 128-byte record through round.takeReceipt inside one `timed` block. #1550 capped the bytes (16 MB) and
// the time to READ them, not the work: a record naming a mark the seat holds and a committee key, with bytes other than
// the receipt held, is verified again every time. One seat answering copies of a committee member's real receipt with one
// signature byte changed holds the honest seat's event loop for seconds per entry (about 130,000 records fit in 16 MB).
// Safe: what one peer's /receipts can cost is bounded (it can add at most one receipt per committee key per mark).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { lockPort } from './lock-fixture.js';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { WINNER, wait } from './window-fixture.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { SIGNED_RECEIPT_BYTES, splitSignedReceipt, decodeCheckpointReceipt } from '../../arena-protocol/src/receipt.js';

test('#1489-r4-play-3: one peer\'s padded /receipts answer does not hold an honest seat\'s thread', async () => {
  let body = null;
  const evil = createServer((req, res) => {
    if (req.url.startsWith('/receipts') && body) { res.writeHead(200, { 'content-type': 'application/octet-stream' }); return res.end(body); }
    res.writeHead(404); return res.end('no');
  });
  await new Promise((r) => evil.listen(0, '127.0.0.1', r));
  const port = lockPort();
  const w = await lockRound({ port });
  try {
    const won = await lockAndPlay(w, WINNER);
    // a receipt seat B issued for a mark seat A holds, signed by B (a committee key)
    const held = w.b.round.receipts(w.rid, won.eid);
    let real = null;
    for (let at = 0; at + SIGNED_RECEIPT_BYTES <= held.bytes.length; at += SIGNED_RECEIPT_BYTES) {
      const one = held.bytes.slice(at, at + SIGNED_RECEIPT_BYTES);
      if (toHex(decodeCheckpointReceipt(splitSignedReceipt(one).body).nodePubkey) === toHex(w.b.round.pubkey)) { real = Buffer.from(one); break; }
    }
    assert.ok(real, 'seat A holds no receipt of seat B to copy');
    const bad = Buffer.from(real); bad[bad.length - 5] ^= 0x01;
    const COPIES = 4000;
    body = Buffer.concat(Array.from({ length: COPIES }, () => bad));
    w.a.verifier.peers = [`http://127.0.0.1:${evil.address().port}`];
    let last = Date.now(); let worst = 0;
    const tick = setInterval(() => { const now = Date.now(); worst = Math.max(worst, now - last); last = now; }, 20);
    const t0 = Date.now();
    const rep = await w.a.verifier.carryReceipts(w.rid, won.eid);
    const took = Date.now() - t0;
    clearInterval(tick);
    const facts = { copies: COPIES, bodyBytes: body.length, peers: w.a.verifier.peersOf(w.rid).length, taken: rep.taken, refused: rep.refused.length, tookMs: took, worstLoopGapMs: worst };
    console.log('  FACTS:', JSON.stringify(facts));
    assert.ok(worst < 2000, `one peer's ${COPIES} padded /receipts records held the seat's thread ${worst} ms in one carry (${took} ms in all)`);
  } finally {
    evil.closeAllConnections(); evil.close();
    await Promise.race([w.close(), wait(5000)]);
  }
});
