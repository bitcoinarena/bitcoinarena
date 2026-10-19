// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// The digest must describe the state, not the machine.
//
// This is the gap the cross-architecture run could not see: x86-64 and arm64
// are both little-endian, so hashing the raw bytes of an Int32Array agreed on
// both while the assumption behind it went unexamined. A big-endian verifier
// would have rejected every player, with neither side wrong.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, hash, CANONICAL_LITTLE_ENDIAN } from '../src/state.js';
import { sha256hex } from '../src/sha256.js';

test('the protocol fixes a byte order rather than inheriting one', () => {
  assert.equal(CANONICAL_LITTLE_ENDIAN, true);
});

test('the digest is the little-endian encoding of the words', () => {
  const st = create();
  st.i32[0] = 0x01020304;
  st.i32[1] = -1;

  // built by hand, in the order the protocol specifies, without touching the
  // buffer's own byte layout
  const bytes = new Uint8Array(st.u8.length);
  for (let i = 0; i < st.i32.length; i++) {
    const v = st.i32[i], o = i << 2;
    bytes[o] = v & 255;
    bytes[o + 1] = (v >>> 8) & 255;
    bytes[o + 2] = (v >>> 16) & 255;
    bytes[o + 3] = (v >>> 24) & 255;
  }
  assert.equal(hash(st), sha256hex(bytes),
    'the digest follows the host byte order instead of the protocol');
});

test('a one-bit change anywhere in the state changes the digest', () => {
  const a = create(), b = create();
  assert.equal(hash(a), hash(b));
  b.i32[b.i32.length - 1] = 1;
  assert.notEqual(hash(a), hash(b), 'the tail of the buffer is not hashed');
});
