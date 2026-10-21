// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE TESTNET4 UP/DOWN MARKET: its signed manifest holds this app's own market (plugin/market-terms.js) - its terms, its period and its
// client - with its own developer and attestor keys, and the testnet4 donation key set; pinned for testnet4 only. (That it equals the
// Arena's regtest test market is the Arena's test: arena-node/test/updown-tn4-regtest.test.js.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { toHex } from 'arena-sdk/hash';
import { gameIdOf, isAttested } from 'arena-sdk/manifest';
import { donationSetId } from 'arena-sdk/donation';
import { TESTNET4_DONATION_SET_KEYS } from 'arena-sdk/testnet4-donation-set-keys';
import { NETWORK_ID_TESTNET4 } from 'arena-sdk/genesis-ids';
import { UPDOWN_TERMS, UPDOWN_PERIOD_MS, UPDOWN_CLIENT_HASH } from '../plugin/market-terms.js';
import { UPDOWN_TN4, UPDOWN_TN4_GAME_ID } from '../plugin/btc-updown.js';
import { UPDOWN_TN4_ATTESTORS, UPDOWN_TN4_DEV_PUBKEY } from '../plugin/attestors.js';
import { KNOWN_GAME } from '../plugin/known.js';
import { KNOWN_GOOD_GAMES } from 'arena-sdk/known-games';

test('the testnet4 market: game 672415c8, this app\'s terms, period and client, its own keys, testnet4\'s donation set', () => {
  const m = UPDOWN_TN4.manifest;
  assert.equal(toHex(UPDOWN_TN4_GAME_ID).slice(0, 8), '672415c8');
  assert.ok(isAttested(m));
  assert.equal(m.gameName, 'btc-updown-15m');
  assert.equal(m.roundPeriodMs, UPDOWN_PERIOD_MS);
  assert.equal(m.attestThreshold, 2);
  for (const k of Object.keys(UPDOWN_TERMS)) assert.deepEqual(m.marketTerms[k], UPDOWN_TERMS[k], k);
  assert.deepEqual(m.clients.map(toHex), [toHex(UPDOWN_CLIENT_HASH)], 'its client, byte for byte');
  assert.equal(toHex(m.gameDevPubkey), UPDOWN_TN4_DEV_PUBKEY);
  assert.deepEqual(m.attestors.map(toHex).sort(), Object.values(UPDOWN_TN4_ATTESTORS).sort());
  assert.equal(toHex(m.gameDonationSetId), toHex(donationSetId(TESTNET4_DONATION_SET_KEYS.recipients)));
  void gameIdOf;
});

test('known to the client for testnet4 only', () => {
  assert.deepEqual(KNOWN_GAME.networks, [toHex(NETWORK_ID_TESTNET4)]);
  const k = KNOWN_GOOD_GAMES[toHex(UPDOWN_TN4_GAME_ID)];
  assert.ok(k, 'in known-games');
  assert.deepEqual(k.attested.networks, [toHex(NETWORK_ID_TESTNET4)]);
  assert.equal(k.attested.threshold, 2);
});
