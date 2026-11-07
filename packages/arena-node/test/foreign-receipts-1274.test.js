// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1274 (audit 4 #1257 outsider-2): a receipt for a mark this seat does not hold is kept as 13B's divergence signal, checked only under the key it
// names - so any /play client wrote a foreign_receipts row per frame (its own key, any 32-byte checkpoint id), never pruned, all served at
// GET /foreign-receipts. Now at most FOREIGN_RECEIPTS_KEPT are kept, none older than a day.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openStore } from '../src/store.js';
import { Round, FOREIGN_RECEIPTS_KEPT, FOREIGN_RECEIPTS_MAX_AGE_MS } from '../src/round.js';
import { encodeCheckpointReceipt, receiptId, joinSignedReceipt } from '../../arena-protocol/src/receipt.js';

test('#1274 receipts for marks this seat does not hold are kept up to the cap, the oldest first out, none past a day', () => {
  const round = new Round(openStore(':memory:'));
  let now = 1_800_000_000_000;
  round.now = () => now;
  const secret = schnorr.utils.randomSecretKey(), key = schnorr.getPublicKey(secret);
  const send = () => {
    const r = { checkpointId: crypto.getRandomValues(new Uint8Array(32)), receivedAtMs: BigInt(now), nodePubkey: key };
    const body = encodeCheckpointReceipt(r);
    try { round.takeReceipt(joinSignedReceipt(body, schnorr.sign(receiptId(r), secret))); } catch { /* "a receipt for a mark this node has not got" */ }
    now += 1;
  };
  const N = FOREIGN_RECEIPTS_KEPT + 200;
  const first = (() => { send(); return round.foreignReceipts()[0]; })();
  for (let i = 1; i < N; i++) send();
  const kept = round.foreignReceipts();
  const firstKept = kept.some((x) => Buffer.compare(Buffer.from(x.checkpointId), Buffer.from(first.checkpointId)) === 0);
  now += FOREIGN_RECEIPTS_MAX_AGE_MS + 1;
  send();
  const afterADay = round.foreignReceipts().length;
  console.log('  FACTS #1274:', JSON.stringify({ sent: N, kept: kept.length, cap: FOREIGN_RECEIPTS_KEPT, oldestStillKept: firstKept, keptAfterADay: afterADay }));
  assert.equal(kept.length, FOREIGN_RECEIPTS_KEPT, 'foreign receipts grew past the cap');
  assert.equal(firstKept, false, 'the oldest was not the first out');
  assert.equal(afterADay, 1, 'rows older than a day were kept');
});
