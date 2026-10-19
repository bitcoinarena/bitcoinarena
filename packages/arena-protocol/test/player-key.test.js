// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE PLAYER'S KEY FROM THE PLAYER'S SEED, FRESH PER ROUND, WITH A FINGERPRINT
// (§24, v4.6.2, F2). Protocol carries no curve, so `pointX` is a stand-in here;
// the real curve is in the client's and the node's tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taggedHash, toHex } from '../src/hash.js';
import { FIELD, scalarFrom32 } from '../src/shares.js';
import { playerSecretFor, refundFingerprint, playerKeyIsDerived } from '../src/player-key.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const curve = { pointX: (s) => taggedHash('stand-in point', s) };

test('one seed makes one key per round, a different one each round, and a scalar every time', () => {
  const seed = b32(0x5e);
  const one = playerSecretFor(seed, b32(1));
  assert.equal(toHex(one), toHex(playerSecretFor(seed, b32(1))), 'the same seed and round drew two keys');
  assert.notEqual(toHex(one), toHex(playerSecretFor(seed, b32(2))), 'two rounds share a key, so their locks link');
  assert.notEqual(toHex(one), toHex(playerSecretFor(b32(0x5f), b32(1))), 'two seeds share a key');
  for (let r = 0; r < 64; r++) {
    const v = scalarFrom32(playerSecretFor(seed, b32(r)));
    assert.ok(v > 0n && v < FIELD);
  }
  assert.throws(() => playerSecretFor(b32(1).slice(0, 31), b32(1)), /seed is 32 bytes/);
});

test('the fingerprint is 64 bits of the refund key, four groups of four', () => {
  const f = refundFingerprint(b32(7));
  assert.match(f, /^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/);
  assert.equal(f, refundFingerprint(b32(7)));
  assert.notEqual(f, refundFingerprint(b32(8)));
});

test('only the seed\'s own key for the round passes, and says its fingerprint', () => {
  const seed = b32(0x5e), rid = b32(1);
  const key = curve.pointX(playerSecretFor(seed, rid));
  assert.deepEqual(playerKeyIsDerived({ seed, roundId: rid, playerPubkey: key, curve }),
    { ok: true, fingerprint: refundFingerprint(key) });
  assert.match(playerKeyIsDerived({ seed, roundId: b32(2), playerPubkey: key, curve }).why,
    /not the one this seed makes for this round/);
  assert.match(playerKeyIsDerived({ seed, roundId: rid, playerPubkey: key }).why, /needs a curve/);
});

test('an order\'s key: order 0 is the round\'s key byte for byte; every order its own, fixed by the seed', () => {
  const seed = b32(7), rid = b32(9);
  assert.equal(toHex(playerSecretFor(seed, rid, 0)), toHex(playerSecretFor(seed, rid)), 'order 0 is the key games and single picks always had');
  const keys = [1, 2, 3, 0xffffffff].map((n) => toHex(playerSecretFor(seed, rid, n)));
  assert.equal(new Set([toHex(playerSecretFor(seed, rid)), ...keys]).size, 5, 'five orders, five keys');
  assert.equal(toHex(playerSecretFor(seed, rid, 2)), keys[1], 'the same seed, round and order make the same key again');
  assert.notEqual(toHex(playerSecretFor(seed, b32(10), 2)), keys[1], 'order 2 of another round is another key');
  for (const bad of [-1, 1.5, 2 ** 32, '1']) assert.throws(() => playerSecretFor(seed, rid, bad), /order number/);
});
