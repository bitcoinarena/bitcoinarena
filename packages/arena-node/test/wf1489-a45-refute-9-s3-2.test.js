// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 a45 refute 9 skeptic 3 (of #2239): #2239 says "a reader reads one seat's answer up to SERVED_ANSWER_BYTES_MAX bytes
// (server.js, item-buy.js)", but only server.js got the bound. The page's copy (arena-client item-buy.js servedFromSeats, bundled in
// dist/arena-client.js and src/arena-ui/arena-client.js) still reads a seat's whole /served?finals=1 answer with r.json().
// Safe: an answer larger than SERVED_ANSWER_BYTES_MAX is not taken, as on the seat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { signFinalSig } from '../../arena-protocol/src/final-sig.js';
import { SERVED_ANSWER_BYTES_MAX } from '../../arena-protocol/src/served-nodes.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { servedFromSeats } from '../../arena-client/src/item-buy.js';

test('the page reads a seat\'s served answer only up to the bound the seat uses', async () => {
  const now = Date.now();
  const s = new Uint8Array(32).fill(7), k = schnorr.getPublicKey(s), rid = new Uint8Array(32).fill(1);
  const f = signFinalSig({ roundId: rid, entryId: new Uint8Array(32).fill(2), runId: new Uint8Array(32).fill(3), signerPubkey: k, signedAtMs: BigInt(now - 1000) }, (d) => schnorr.sign(d, s));
  const body = JSON.stringify({ held: [{ roundId: toHex(rid), committee: [toHex(k)], finals: [toHex(f)] }], pad: 'x'.repeat(SERVED_ANSWER_BYTES_MAX + 1024) });
  const fetch = async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  const got = await servedFromSeats({ seats: ['http://seat.invalid'], toMs: now, fetch, verify: (sg, m, kk) => schnorr.verify(sg, m, kk) });
  console.log(`a ${(body.length / 1e6).toFixed(1)} MB answer (bound ${SERVED_ANSWER_BYTES_MAX / 1e6} MB): ${got.ok ? 'taken' : 'not taken: ' + got.why}`);
  assert.equal(got.ok, false, 'an answer over SERVED_ANSWER_BYTES_MAX was read whole and taken by the page');
});
