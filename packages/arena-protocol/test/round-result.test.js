// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHO WON A PRICE ROUND (§13 RoundResult): the object, its front, and the result a node makes from its samples.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FRONT, frontOf, frontName, encodeRoundResult, decodeRoundResult, roundResultId, roundResultFrom } from '../src/round-result.js';

const rid = new Uint8Array(32).fill(7);

test('BULLS if the close is higher, BEARS if lower, FLAT if equal; the bytes read back, and a front that does not follow is refused', () => {
  assert.deepEqual([frontOf(100, 101), frontOf(100, 99), frontOf(100, 100)], [FRONT.BULLS, FRONT.BEARS, FRONT.FLAT]);
  assert.equal(frontName(FRONT.BEARS), 'BEARS');
  const x = { roundId: rid, openCents: 8297000, closeCents: 8300500, front: FRONT.BULLS };
  const b = encodeRoundResult(x);
  assert.equal(b.length, 1 + 2 + 32 + 4 + 4 + 1);
  assert.deepEqual(decodeRoundResult(b), x);
  assert.throws(() => encodeRoundResult({ ...x, front: FRONT.BEARS }), /does not follow/);
  const bad = b.slice(); bad[bad.length - 1] = FRONT.BEARS;
  assert.throws(() => decodeRoundResult(bad), /does not follow/);
  assert.notDeepEqual(roundResultId(x), roundResultId({ ...x, closeCents: 8300501 }));
});

test('a node\'s result: the first attested sample of the round opens, the last at or before the round\'s last tick closes', () => {
  const samples = [{ tick: 4096, priceCents: 120 }, { tick: 0, priceCents: 100 }, { tick: 9000, priceCents: 90 }, { tick: 2048, priceCents: 110 }];
  const got = roundResultFrom({ roundId: rid, samples, endTick: 5000 });
  assert.deepEqual([got.ok, got.result.openCents, got.result.closeCents, frontName(got.result.front), got.samples], [true, 100, 120, 'BULLS', 3]);
  assert.equal(roundResultFrom({ roundId: rid, samples: [], endTick: 5000 }).ok, false);
  assert.equal(frontName(roundResultFrom({ roundId: rid, samples: [{ tick: 1, priceCents: 50 }], endTick: 5 }).result.front), 'FLAT');
});
