// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE KNOWN-GOOD FEDERATIONS (spec §23.6, kanban #318): the page's own list, like the known games - federation 337ae01a on
// testnet4 and the regtest test federation are on it, any other id is not. Adding one is a reviewed code change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { federationIsKnown, knownFederation, KNOWN_GOOD_FEDERATIONS } from '../src/known-federations.js';
import { TEST_FEDERATION_ID } from '../src/test-federation.js';
import { toHex } from '../src/hash.js';

const TN4 = '337ae01ad1e9bb35b5628faad3457e62d69d036efe8a34bcfc20cb31b42bb75e';
const TN4_B = 'b18947f085d40df3ce4bc8ac64df9c45256223e88fe7fdbdebf3eae13fb10b73';

test('337ae01a on testnet4 and the regtest test federation are known, by hex or by bytes, in any case', () => {
  assert.equal(federationIsKnown(TN4), true);
  assert.equal(federationIsKnown(TN4.toUpperCase()), true);
  assert.equal(federationIsKnown(TEST_FEDERATION_ID), true);
  assert.equal(federationIsKnown(toHex(TEST_FEDERATION_ID)), true);
  assert.equal(knownFederation(TN4).network, 'testnet4');
  assert.equal(knownFederation(toHex(TEST_FEDERATION_ID)).network, 'regtest');
  assert.equal(Object.keys(KNOWN_GOOD_FEDERATIONS).length, 3);
});

test('federation B on testnet4 is known too (kanban #348): a deposit may go to the one with less funds', () => {
  assert.equal(federationIsKnown(TN4_B), true);
  assert.deepEqual(knownFederation(TN4_B), { name: 'Arena testnet4 B', network: 'testnet4', nominal: 7, threshold: 5 });
});

test('anything else is not known', () => {
  for (const x of ['37'.repeat(32), TN4.slice(0, 63) + 'f', TN4.slice(0, 16), '', null, undefined, new Uint8Array(32), '__proto__', 'constructor'])
    assert.equal(federationIsKnown(x), false, String(x));
  assert.equal(knownFederation('37'.repeat(32)), null);
  assert.ok(Object.isFrozen(KNOWN_GOOD_FEDERATIONS));
});
