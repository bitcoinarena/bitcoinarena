// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A SEAT SIGNS THE FRONT A PRICE ROUND'S RUN ENDED ON (§13 front_*): resultFrom with the round played against the feed
// writes the run's open, close and front (LIVE) off its own attested samples - 178 bytes; any other round's result keeps its 168.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resultFrom } from '../src/verdict.js';
import { decodePlayerResult } from '../../arena-protocol/src/result.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const core = b32(4);
const args = (priceRound) => ({
  answer: { ok: true, outcome: 'DELIVERED', score: 18321, coreHash: Buffer.from(core).toString('hex') },
  contract: { simCoreHash: core }, entry: { roundId: b32(1), playerPubkey: b32(2) }, entryId: b32(3), nodePubkey: b32(5),
  transcript: { roundId: b32(1), entryId: b32(3), hash: b32(6), batches: [{ attests: [[0, 0, 7500000, []]] }, { attests: [[12288, 0, 7480000, []]] }] },
  priceRound,
});

test('a price round\'s result carries the run\'s front, BEARS here (7,500,000 -> 7,480,000 cents); another round\'s does not', () => {
  const p = resultFrom(args(true));
  assert.equal(p.ok, true, p.why);
  assert.equal(p.encoded.length, 178);
  assert.deepEqual([p.result.front, p.result.frontOpenCents, p.result.frontCloseCents, p.result.frontMode], [2, 7500000, 7480000, 1]);
  assert.deepEqual(decodePlayerResult(p.encoded).frontCloseCents, 7480000);
  const n = resultFrom(args(false));
  assert.equal(n.encoded.length, 168);
  assert.equal(n.result.front, undefined);
});
