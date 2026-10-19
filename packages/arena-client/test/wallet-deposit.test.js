// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A DEPOSIT BEFORE ANY ROUND (2026-10-12 "Yes": Deposit on the games screen before a game is picked).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { walletDepositChoices, WALLET_DEPOSIT_SATS, depositOffer } from '../src/page-lock.js';

test('with no round, the tabs are plain sat amounts and Custom', () => {
  const c = walletDepositChoices();
  assert.deepEqual(c.map((x) => x.label), ['1,000 sat', '5,000 sat', '10,000 sat', '50,000 sat', 'Custom']);
  assert.deepEqual(c.slice(0, 4).map((x) => x.msat), WALLET_DEPOSIT_SATS.map((s) => BigInt(s) * 1000n));
  assert.equal(c.every((x) => x.rounds === null), true, 'no tab claims a number of rounds');
  assert.equal(c[4].msat, null);
});

test('an offer carries the choices it was given; without them, the rounds tabs as before', () => {
  const given = walletDepositChoices();
  assert.deepEqual(depositOffer({ client: {}, stakeMsat: 0n, choices: given }).choices, given);
  assert.deepEqual(depositOffer({ client: {}, stakeMsat: 100000n }).choices.map((x) => x.label), ['1 round', '2 rounds', '5 rounds', '10 rounds', 'Custom']);
});
