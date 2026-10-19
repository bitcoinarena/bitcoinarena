// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// PICK B (RULED the owner 2026-09-30 08:55): series 3cfbe516 of testnet4's id before genesis_series_start is taken - its
// 24 h lead is enough, no grid - and nothing else of that id is: another series under it is still held to the rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { decodeRoundContract, roundId } from '../src/contracts.js';
import { seriesLeadIsValid, seriesId, seriesRound, seriesClockFor, SERIES_CLOCKS } from '../src/series.js';
import { networkOf } from '../src/constants.js';
import { donationKeysForNetworkId } from '../src/donation-keys.js';
import { NETWORK_ID_TESTNET4_BEFORE_SERIES_GENESIS, OLD_TESTNET4_SERIES_ID } from '../src/old-series.js';
import { TEST_DONATION_SET_TESTNET4_BEFORE_SERIES_GENESIS } from '../src/test-donation-sets.js';
import { donationSetId } from '../src/donation.js';
import { toHex, fromHex } from '../src/hash.js';

// THE SERIES AS PUBLISHED (3029fc6f, block 154237): its template, the file the testnet4 operator kept
const FILE = '/home/arena/blwp-testnet4/series/series-3cfbe516d93ddf4b.json';
const template = existsSync(FILE) ? decodeRoundContract(fromHex(JSON.parse(readFileSync(FILE, 'utf8')).template)) : null;

test('series 3cfbe516 under the old testnet4 id: its id, its 24 h lead taken, testnet4 genesis, its donation set', { skip: !template && 'no series file here' }, () => {
  assert.equal(toHex(seriesId(template)), toHex(OLD_TESTNET4_SERIES_ID));
  assert.equal(toHex(template.networkId), toHex(NETWORK_ID_TESTNET4_BEFORE_SERIES_GENESIS));
  const lead = seriesLeadIsValid(template);
  assert.equal(lead.ok, true, lead.why);
  assert.equal(lead.leadMs, 86400000n);
  assert.equal(networkOf(template.networkId), 'testnet4');
  assert.equal(seriesClockFor(template.networkId), SERIES_CLOCKS.testnet4);
  assert.equal(donationKeysForNetworkId(template.networkId).network, 'testnet4');
  assert.equal(toHex(donationSetId(TEST_DONATION_SET_TESTNET4_BEFORE_SERIES_GENESIS.recipients)), toHex(template.donationSetId));
  // its rounds derive as before: round i's id is H(series || i)
  assert.ok(roundId(seriesRound(template, 442)) instanceof Uint8Array);
});

test('any other series under the old id is still held to the rules: off the grid is refused', { skip: !template && 'no series file here' }, () => {
  const other = { ...template, stakeMsat: template.stakeMsat + 1n };          // another series id, the same old network
  assert.notEqual(toHex(seriesId(other)), toHex(OLD_TESTNET4_SERIES_ID));
  const lead = seriesLeadIsValid(other);
  assert.equal(lead.ok, false);
  assert.match(lead.why, /genesis_series_start/);
});
