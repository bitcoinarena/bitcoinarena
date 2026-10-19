// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE LOBBY IDENTITY KEY (M3.3-34): from the tab's seed, under its own tag, and
// never any round's player key - so a name shown in a lobby can never be the
// key a stake refunds to or a payout is sent to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { identitySecretFor, playerSecretFor } from '../src/player-key.js';
import { FIELD, scalarFrom32 } from '../src/shares.js';
import { TAG } from '../src/constants.js';
import { toHex } from '../src/hash.js';

const rand = (n) => new Uint8Array(randomBytes(n));

test('the identity secret is the seed\'s, under its own tag, and no round\'s player key', () => {
  const seed = rand(32);
  const a = identitySecretFor(seed);
  assert.equal(a.length, 32);
  assert.equal(toHex(identitySecretFor(seed)), toHex(a), 'the same seed made two identities');
  const v = scalarFrom32(a);
  assert.ok(v > 0n && v < FIELD, 'the identity secret is not a scalar of the group');
  assert.notEqual(toHex(identitySecretFor(rand(32))), toHex(a), 'two seeds made one identity');
  for (let i = 0; i < 20; i++)
    assert.notEqual(toHex(playerSecretFor(seed, rand(32))), toHex(a), 'the identity is a round\'s player key');
  // ITS OWN TAG: no other object of the protocol hashes under it.
  assert.equal(Object.values(TAG).filter((t) => t === TAG.lobbyIdentity).length, 1);
  assert.throws(() => identitySecretFor(rand(31)), /32 bytes/);
  assert.throws(() => identitySecretFor(null), /32 bytes/);
});
