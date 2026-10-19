// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE TESTNET4 UP/DOWN MARKET: its signed manifest is the regtest market's in every term and its client,
// with its own developer and attestor keys, and the testnet4 donation key set; pinned for testnet4 only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { toHex } from '../../arena-protocol/src/hash.js';
import { gameIdOf, isAttested } from '../../arena-protocol/src/manifest.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { TESTNET4_DONATION_SET_KEYS } from '../../arena-protocol/src/testnet4-donation-set-keys.js';
import { NETWORK_ID_TESTNET4 } from '../../arena-protocol/src/genesis-ids.js';
import { UPDOWN } from '../../arena-node/test/plugins/updown/index.js';
import { UPDOWN_TN4, UPDOWN_TN4_GAME_ID } from '../plugin/btc-updown.js';
import { UPDOWN_TN4_ATTESTORS, UPDOWN_TN4_DEV_PUBKEY } from '../plugin/attestors.js';
import { KNOWN_GAME } from '../plugin/known.js';
import { KNOWN_GOOD_GAMES } from '../../arena-protocol/src/known-games.js';

test('the testnet4 market: game 672415c8, the regtest market\'s terms and client, its own keys, testnet4\'s donation set', () => {
  const m = UPDOWN_TN4.manifest, r = UPDOWN.registration.manifest;
  assert.equal(toHex(UPDOWN_TN4_GAME_ID).slice(0, 8), '672415c8');
  assert.ok(isAttested(m));
  for (const k of ['gameName', 'roundPeriodMs', 'attestThreshold', 'resultType', 'payoutRule']) assert.deepEqual(m[k], r[k], k);
  assert.deepEqual(m.outcomes, r.outcomes);
  assert.deepEqual(m.marketTerms, r.marketTerms, 'question, source rule, fees, resolution and void clock');
  assert.deepEqual(m.clients.map(toHex), r.clients.map(toHex), 'the same client, byte for byte');
  assert.equal(toHex(m.gameDevPubkey), UPDOWN_TN4_DEV_PUBKEY);
  assert.deepEqual(m.attestors.map(toHex).sort(), Object.values(UPDOWN_TN4_ATTESTORS).sort());
  assert.ok(!m.attestors.some((a) => r.attestors.some((b) => toHex(a) === toHex(b))), 'none of the public test keys');
  assert.equal(toHex(m.gameDonationSetId), toHex(donationSetId(TESTNET4_DONATION_SET_KEYS.recipients)));
  assert.notEqual(toHex(gameIdOf(m)), toHex(gameIdOf(r)));
});

test('known to the client for testnet4 only', () => {
  assert.deepEqual(KNOWN_GAME.networks, [toHex(NETWORK_ID_TESTNET4)]);
  const k = KNOWN_GOOD_GAMES[toHex(UPDOWN_TN4_GAME_ID)];
  assert.ok(k, 'in known-games');
  assert.deepEqual(k.attested.networks, [toHex(NETWORK_ID_TESTNET4)]);
  assert.equal(k.attested.threshold, 2);
});
