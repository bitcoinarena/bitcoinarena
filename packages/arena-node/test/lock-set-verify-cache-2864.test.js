// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #2864: a seat checks a lock-set signature once - the answer for (sig, msg, key) is kept, true and false alike; a changed byte is a new check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { lsVerifyForTest as v } from '../src/lock-set-book.js';

test('#2864 lsVerify keeps its answers: the same bytes are checked once, a changed byte again, a bad signature stays bad', () => {
  const sec = new Uint8Array(32).fill(7), key = schnorr.getPublicKey(sec), msg = new Uint8Array(32).fill(3), sig = schnorr.sign(msg, sec);
  assert.equal(v(sig, msg, key), true);
  const N = 300; let t = performance.now(); for (let i = 0; i < N; i++) v(sig, msg, key); const kept = performance.now() - t;
  t = performance.now(); for (let i = 0; i < 30; i++) schnorr.verify(sig, msg, key); const fresh = ((performance.now() - t) / 30) * N;
  console.log(`  FACTS: ${N} kept checks ${kept.toFixed(1)} ms, as fresh checks ~${fresh.toFixed(0)} ms`);
  assert.ok(kept * 5 < fresh, 'kept answers cost far less than fresh checks');
  const bad = Uint8Array.from(sig); bad[5] ^= 1;
  assert.equal(v(bad, msg, key), false); assert.equal(v(bad, msg, key), false);
  const other = Uint8Array.from(msg); other[0] ^= 1;
  assert.equal(v(sig, other, key), false, 'another message is checked on its own');
  assert.equal(v(sig, msg, key), true);
});
