// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 audit44 refute of #1636: carryReceipts is bounded only for records that FAIL to verify. A peer answering
// /receipts with records that VERIFY - each under a key of its own choosing, each for a fresh random checkpointId (a mark
// this seat has not got) - passes the per-(mark,signer) dedupe (every key is new), is never "does not verify", so it is
// read to the end: one schnorr verify plus an INSERT, a DELETE, a COUNT and a DELETE on foreign_receipts per record,
// at every close and every retryClose (no byte-equal shortcut on the foreign path). The yield keeps the loop gap small,
// but the work is unbounded (up to ~130,000 per 16 MB answer) and it flushes every real divergence signal
// (FOREIGN_RECEIPTS_KEPT 4096) from the seat's foreign_receipts table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { lockPort } from './lock-fixture.js';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { WINNER, wait } from './window-fixture.js';
import { encodeCheckpointReceipt, joinSignedReceipt, receiptId } from '../../arena-protocol/src/receipt.js';

const signed = (secret, pub, checkpointId) => {
  const r = { checkpointId, receivedAtMs: BigInt(Date.now()), nodePubkey: pub };
  return Buffer.from(joinSignedReceipt(encodeCheckpointReceipt(r), schnorr.sign(receiptId(r), secret)));
};

test('#1489-a44-refute-35-s1-1: a peer\'s VERIFYING foreign receipts are read without bound and flush divergence signals', { timeout: 600000 }, async () => {
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
    // a genuine divergence signal: some key receipted a mark seat A never got
    const ks = schnorr.utils.randomSecretKey ? schnorr.utils.randomSecretKey() : randomBytes(32);
    const kp = schnorr.getPublicKey(ks);
    const realId = randomBytes(32);
    assert.throws(() => w.a.round.takeReceipt(signed(ks, kp, realId)), /has not got/);
    const has = () => !!w.a.round.db.prepare('SELECT 1 FROM foreign_receipts WHERE checkpoint_id = ?').get(realId);
    assert.ok(has(), 'the divergence signal was not filed');
    await wait(5);

    // the evil peer: N receipts that all verify, each under a fresh key, each for a random mark
    const N = 6000;
    const parts = [];
    for (let i = 0; i < N; i++) {
      const s = randomBytes(32);
      let p; try { p = schnorr.getPublicKey(s); } catch { i--; continue; }
      parts.push(signed(s, p, randomBytes(32)));
    }
    body = Buffer.concat(parts);
    w.a.verifier.peers = [`http://127.0.0.1:${evil.address().port}`];
    const t0 = Date.now();
    const rep = await w.a.verifier.carryReceipts(w.rid, won.eid);
    const took1 = Date.now() - t0;
    const t1 = Date.now();
    const rep2 = await w.a.verifier.carryReceipts(w.rid, won.eid); // a retryClose pays it all again
    const took2 = Date.now() - t1;
    const facts = { records: N, bodyBytes: body.length, refused1: rep.refused.length, tookMs1: took1, refused2: rep2.refused.length, tookMs2: took2,
      divergenceSignalKept: has(), foreignRows: w.a.round.db.prepare('SELECT COUNT(*) AS n FROM foreign_receipts').get().n };
    console.log('  FACTS:', JSON.stringify(facts));
    assert.ok(has(), `one peer's ${N} verifying foreign receipts flushed seat A's real divergence signal from foreign_receipts`);
    assert.ok(rep.refused.length <= 256, `one peer's /receipts answer cost ${rep.refused.length} schnorr verifies + foreign_receipts writes in one carry (${took1} ms), again ${rep2.refused.length} at the retry (${took2} ms)`);
  } finally {
    evil.closeAllConnections(); evil.close();
    await Promise.race([w.close(), wait(5000)]);
  }
});
