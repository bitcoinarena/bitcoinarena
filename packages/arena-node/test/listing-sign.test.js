// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE LISTING SIGNER (2026-10-25, measured on testnet4: a full listing's 9,760 rows signed again each window held the lobby's
// `?next=8` asks 22-30 s behind it): a large ask is signed in chunks, and an ask of one chunk or less goes before the chunks still waiting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { listingSigner } from '../src/listing-sign.js';

test('a small ask is answered before a large one asked earlier, and every signature is the message\'s, in order', async () => {
  const secret = new Uint8Array(32).fill(3), pub = schnorr.getPublicKey(secret);
  const signer = listingSigner(secret, { chunk: 16 });
  try {
    const msg = (i) => { const m = new Uint8Array(32); m[0] = i & 255; m[1] = i >> 8; return m; };
    const big = Array.from({ length: 200 }, (_, i) => msg(i)), few = [msg(1000), msg(1001)];
    const done = [];
    const a = signer.sign(big).then((s) => { done.push('large'); return s; });
    const b = signer.sign(few).then((s) => { done.push('small'); return s; });
    const [sa, sb] = await Promise.all([a, b]);
    assert.deepEqual(done, ['small', 'large'], 'the small ask did not wait for the large one');
    assert.equal(sa.length, 200);
    assert.ok(sa.every((s, i) => schnorr.verify(s, big[i], pub)), 'every signature of the large ask is its own message\'s');
    assert.ok(sb.every((s, i) => schnorr.verify(s, few[i], pub)));
    assert.deepEqual(await signer.sign([]), []);
  } finally { await signer.close(); }
});
