// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// verified.js: a kept answer is the verifier's own answer, true and false alike, and stays so when asked again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { verifySchnorrKept, verifyEd25519Kept } from '../src/verified.js';

const rand = (n) => new Uint8Array(randomBytes(n));

test('a kept Schnorr answer is schnorr.verify\'s, first and again', () => {
  const sk = rand(32), pk = schnorr.getPublicKey(sk), msg = rand(32), sig = schnorr.sign(msg, sk);
  const bad = Uint8Array.from(sig); bad[5] ^= 1;
  const other = schnorr.getPublicKey(rand(32));
  for (let round = 0; round < 2; round++) {
    assert.equal(verifySchnorrKept(sig, msg, pk), true);
    assert.equal(verifySchnorrKept(bad, msg, pk), false);
    assert.equal(verifySchnorrKept(sig, msg, other), false);
    assert.equal(verifySchnorrKept(sig, rand(32), pk), false);
  }
});

test('a kept Ed25519 answer is ed25519.verify\'s, first and again', () => {
  const sk = rand(32), pk = ed25519.getPublicKey(sk), msg = rand(40), sig = ed25519.sign(msg, sk);
  const bad = Uint8Array.from(sig); bad[0] ^= 1;
  for (let round = 0; round < 2; round++) {
    assert.equal(verifyEd25519Kept(sig, msg, pk), true);
    assert.equal(verifyEd25519Kept(bad, msg, pk), false);
  }
});

test('malformed input is false, never a throw, kept or not', () => {
  assert.equal(verifySchnorrKept(new Uint8Array(3), new Uint8Array(32), new Uint8Array(32)), false);
  assert.equal(verifySchnorrKept(null, new Uint8Array(32), new Uint8Array(32)), false);
  assert.equal(verifyEd25519Kept(new Uint8Array(64), new Uint8Array(1), new Uint8Array(5)), false);
  assert.equal(verifyEd25519Kept(undefined, undefined, undefined), false);
});

test('a subarray view is read as its own bytes, not its whole buffer', () => {
  const sk = rand(32), pk = schnorr.getPublicKey(sk), msg = rand(32), sig = schnorr.sign(msg, sk);
  const wide = new Uint8Array(96); wide.set(sig, 16);
  assert.equal(verifySchnorrKept(wide.subarray(16, 80), msg, pk), true);
  const shifted = new Uint8Array(96); shifted.set(sig, 17);
  assert.equal(verifySchnorrKept(shifted.subarray(16, 80), msg, pk), false);
});
