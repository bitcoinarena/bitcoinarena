// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADJECTIVES, ANIMALS,
  displayNameFromKey, displayNameFor, normalizeDisplayName,
  donationCommentFor, playerStoreRecord,
} from '../src/display-name.js';

const key = (n) => new Uint8Array(32).fill(n);

test('the same key always yields the same default name', () => {
  const a = displayNameFromKey(key(7));
  const b = displayNameFromKey(key(7));
  assert.equal(a, b);
  assert.match(a, /^[a-z]+-[a-z]+-\d{4}$/);
  const [adj, animal, num] = a.split('-');
  assert.ok(ADJECTIVES.includes(adj));
  assert.ok(ANIMALS.includes(animal));
  assert.equal(num.length, 4);
});

test('a different key is a different default name', () => {
  assert.notEqual(displayNameFromKey(key(1)), displayNameFromKey(key(2)));
});

test('a custom name replaces the default, an empty one does not', () => {
  const def = displayNameFromKey(key(3));
  assert.equal(displayNameFor(key(3), 'George'), 'George');
  assert.equal(displayNameFor(key(3), '  '), def);
  assert.equal(displayNameFor(key(3), null), def);
  assert.equal(normalizeDisplayName('brave—otter'), null);
  assert.equal(normalizeDisplayName('has/slash'), null);
  assert.equal(normalizeDisplayName('x'.repeat(33)), null);
});

test('the donation comment is the public key as hex, not the display name', () => {
  const hex = '04'.repeat(32);
  assert.equal(donationCommentFor(key(4)), hex);
  assert.equal(donationCommentFor(key(4), 140), hex);
  assert.equal(donationCommentFor(key(4), 63), '');
  assert.notEqual(donationCommentFor(key(4)), displayNameFromKey(key(4)));
});

test('the browser record keeps the secret as hex and drops a bad custom name', () => {
  const rec = playerStoreRecord({ secretKey: key(9), displayName: '  Kit  ' });
  assert.equal(rec.version, 1);
  assert.equal(rec.secretKey.length, 64);
  assert.equal(rec.displayName, 'Kit');
  const plain = playerStoreRecord({ secretKey: key(9), displayName: 'nope!' });
  assert.equal(plain.displayName, null);
});
