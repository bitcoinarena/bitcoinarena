// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageCurve } from '../src/page-curve.js';
import { feldmanGroup } from '../../arena-node/src/curve.js';
import { schnorr } from '@noble/curves/secp256k1.js';

test('the page verifies a node advert the way the daemon signed it', () => {
  const secret = new Uint8Array(32).fill(7);
  secret[31] = 9;
  const pub = schnorr.getPublicKey(secret);
  const msg = new Uint8Array(32).fill(1);
  const sig = schnorr.sign(msg, secret);
  assert.equal(pageCurve.verify(sig, msg, pub), true);
  assert.equal(pageCurve.verify(sig, new Uint8Array(32).fill(2), pub), false);
});

test('the page curve is the daemon curve', () => {
  const secret = new Uint8Array(32).fill(7);
  secret[31] = 9;
  assert.deepEqual(pageCurve.pointX(secret), feldmanGroup.pointX(secret));
  const their = feldmanGroup.pointX(new Uint8Array(32).fill(3));
  assert.deepEqual(pageCurve.ecdhShared(secret, their),
    feldmanGroup.ecdhShared(secret, their));
});

test('the page loads the curve before it joins', () => {
  const page = readFileSync(
    new URL('../../../src/arena-ui/index.html',
      import.meta.url).pathname, 'utf8');
  const curveTag = page.indexOf('src="arena-curve.js"');
  const joinCall = page.indexOf('joinTheRoundIfOneWasNamed');
  assert.ok(curveTag >= 0, 'the page never loads arena-curve.js');
  assert.ok(joinCall > curveTag, 'the curve script is not in front of the join');
  assert.ok(!page.includes('so it is not joining'),
    'a named round still refuses the signer node in silence');
  assert.ok(page.includes('id="arena-players"'), 'the page never shows who is in the round');
});
