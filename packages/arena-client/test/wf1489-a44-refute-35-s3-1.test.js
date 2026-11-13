// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 audit44 refute of #1636 (skeptic 3, second copies): #1636/#2151 bounded the work one peer's GET /receipts
// answer costs a SEAT (verify.js carryReceipts: per-(mark,signer) dedupe, stop on the first bad record, a yield every 64,
// committee-only, a cap on foreign marks). The page's own copy of the same reader - arena-client Client.recoverReceipts,
// called by carriedHead (resume after a drop or a reload, markNow) for this seat AND every committee peer - has none of it:
// no byte cap on the body, no dedupe, one schnorr verify per record, all in one synchronous loop. One committee seat that
// answers its own real (valid) receipt N times freezes the player's page for N verifies on every resume.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { Client } from '../src/client.js';
import { encodeCheckpointReceipt, joinSignedReceipt, receiptId } from '../../arena-protocol/src/receipt.js';

const b32 = (n) => { const b = new Uint8Array(32); b[31] = n; return b; };

test('#1489-a44-refute-35-s3-1: one peer\'s /receipts answer is bounded in work on the page too (recoverReceipts)', { timeout: 300000 }, async () => {
  const nodeKey = schnorr.utils.randomSecretKey ? schnorr.utils.randomSecretKey() : ed25519.utils.randomSecretKey();
  const nodePubkey = schnorr.getPublicKey(nodeKey);
  const r = { checkpointId: b32(3), receivedAtMs: 1788770000000n, nodePubkey };
  const one = Buffer.from(joinSignedReceipt(encodeCheckpointReceipt(r), schnorr.sign(receiptId(r), nodeKey)));
  const N = 4000;
  const body = Buffer.concat(Array.from({ length: N }, () => one));
  const stub = createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(body); });
  await new Promise((ok) => stub.listen(0, '127.0.0.1', ok));
  try {
    const c = new Client({ base: `http://127.0.0.1:${stub.address().port}`, core: {}, sign: () => new Uint8Array(64),
      verify: (sig, msg, pub) => schnorr.verify(sig, msg, pub) });
    c.nodes = [nodePubkey];
    // the loop gap: a timer that should fire every 10 ms
    let last = Date.now(); let worst = 0;
    const tick = setInterval(() => { const n = Date.now(); worst = Math.max(worst, n - last); last = n; }, 10);
    const t0 = Date.now();
    const got = await c.recoverReceipts({ roundId: b32(1), entryId: b32(2) });
    const took = Date.now() - t0;
    await new Promise((ok) => setTimeout(ok, 30));
    clearInterval(tick);
    console.log('  FACTS:', JSON.stringify({ records: N, bodyBytes: body.length, kept: got.length, tookMs: took, worstLoopGapMs: worst }));
    assert.ok(worst < 500, `one peer's /receipts answer of ${N} copies of one valid receipt held the page's thread ${worst} ms (${took} ms, ${got.length} records kept)`);
  } finally { await new Promise((ok) => stub.close(ok)); }
});
