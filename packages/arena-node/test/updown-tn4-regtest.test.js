// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE TESTNET4 UP/DOWN MARKET IS THE REGTEST TEST MARKET with its own keys (kanban #568: this check was in the app's own test; the regtest
// market with its public test keys is the Arena's fixture, so the comparison is the Arena's): every term and the client the same, none of
// the public test keys, a different game id.
import test from 'node:test';
import assert from 'node:assert/strict';
import { toHex } from '../../arena-protocol/src/hash.js';
import { gameIdOf, isAttested } from '../../arena-protocol/src/manifest.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { TESTNET4_DONATION_SET_KEYS } from '../../arena-protocol/src/testnet4-donation-set-keys.js';
import { UPDOWN } from './plugins/updown/index.js';
import { UPDOWN_TN4, UPDOWN_TN4_GAME_ID } from '../../btc-updown/plugin/btc-updown.js';
import { UPDOWN_TN4_ATTESTORS, UPDOWN_TN4_DEV_PUBKEY } from '../../btc-updown/plugin/attestors.js';

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
