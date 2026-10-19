// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE TEST NETWORKS' DONATION SETS, AS COMMITTED (M3.2 6e): signed once offline
// by each network's Ed25519 donation authority (tools/sign-donation-set.mjs),
// public bytes only. Their signatures are checked on the real curve in
// arena-node's donation-set-door.test.js - this package carries no curve.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEST_DONATION_SET_REGTEST, TEST_DONATION_SET_TESTNET4, TEST_DONATION_ENDPOINTS } from '../src/test-donation-sets.js';
import { NETWORK_ID_REGTEST, NETWORK_ID_TESTNET4 } from '../src/genesis-ids.js';
import { donationSetStands, splitDonation, donationSetId } from '../src/donation.js';
import { DONATION_SIGNATURE_BYTES } from '../src/authority.js';
import { urlOfLnurl } from '../src/bech32.js';

const hex = (b) => Buffer.from(b).toString('hex');

test('each test network has one signed set naming two local test recipients, never a production one', () => {
  for (const [set, network] of [[TEST_DONATION_SET_REGTEST, NETWORK_ID_REGTEST], [TEST_DONATION_SET_TESTNET4, NETWORK_ID_TESTNET4]]) {
    assert.equal(hex(set.networkId), hex(network));
    assert.equal(set.serial, 1n);
    assert.equal(set.validFrom, 0);
    assert.equal(set.signature.length, DONATION_SIGNATURE_BYTES);
    assert.equal(donationSetStands(set.recipients).ok, true);
    assert.deepEqual(set.recipients.map((r) => urlOfLnurl(r.lnurl)), TEST_DONATION_ENDPOINTS);
    assert.deepEqual(set.recipients.map((r) => r.shareBps), [6667, 3333]);
  }
  assert.deepEqual(TEST_DONATION_ENDPOINTS, ['http://127.0.0.1:18777/lnurlp/blwp-test-a', 'http://127.0.0.1:18777/lnurlp/blwp-test-b']);
  // the id a round names is over the recipients as published, so both networks' sets name one id
  assert.equal(hex(donationSetId(TEST_DONATION_SET_REGTEST.recipients)), hex(donationSetId(TEST_DONATION_SET_TESTNET4.recipients)));
});

test('a 2% donor\'s 2000 msat splits between the two recipients exactly: 1334 and 666', () => {
  const two = splitDonation({ donationMsat: 2000n, recipients: TEST_DONATION_SET_REGTEST.recipients });
  assert.equal(two.owed, true);
  // floor(2000 * 6667 / 10000) = 1333, floor(2000 * 3333 / 10000) = 666, the 1 left over to the first as published
  assert.deepEqual(two.shares.map((s) => s.amountMsat), [1334n, 666n]);
  const none = splitDonation({ donationMsat: 0n, recipients: TEST_DONATION_SET_REGTEST.recipients });
  assert.deepEqual(none.shares.map((s) => s.amountMsat), [0n, 0n], 'a 0% donor owes nobody anything');
});
