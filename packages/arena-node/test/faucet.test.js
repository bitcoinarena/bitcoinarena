// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// The Arena faucet's rules (kanban #635): an address once, an IP a few times a day, a daily cap, never more than it holds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { faucetDecide, faucetAddressOk, FAUCET_MAX_SATS, DAY_MS } from '../src/faucet.js';

const A = 'tb1pqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0sx9n0a2';
const B = 'tb1q9v8zvd6jgz0xvyq5stk0d4uyh8ux5nevkf92sn';
const now = 20000 * DAY_MS + 3600000;

test('a testnet4 address and a whole amount up to the maximum are paid', () => {
  assert.deepEqual(faucetDecide({ address: A, sats: 60000, ip: '1.2.3.4' }, { paid: [] }, { nowMs: now }), { ok: true, sats: 60000 });
  assert.equal(faucetAddressOk('bc1qxyz0000000000000'), false, 'mainnet is refused');
  assert.match(faucetDecide({ address: 'bc1q9v8zvd6jgz0xvyq5stk0d4uyh8ux5nevkf92sn', sats: 1 }, { paid: [] }).why, /testnet4/);
  assert.match(faucetDecide({ address: A, sats: 1.5 }, { paid: [] }).why, /whole number/);
  assert.match(faucetDecide({ address: A, sats: FAUCET_MAX_SATS + 1 }, { paid: [] }).why, /at most/);
});

test('an address is paid once, an IP three times a day, and never past the daily cap or the balance', () => {
  const book = { paid: [{ address: A, ip: '1.2.3.4', sats: 60000, atMs: now - 1000 }] };
  assert.match(faucetDecide({ address: A, sats: 1000, ip: '9.9.9.9' }, book, { nowMs: now }).why, /already/);
  const busy = { paid: [1, 2, 3].map((i) => ({ address: `tb1qaddress${'x'.repeat(i)}0000000`, ip: '5.5.5.5', sats: 1000, atMs: now - i })) };
  assert.match(faucetDecide({ address: B, sats: 1000, ip: '5.5.5.5' }, busy, { nowMs: now }).why, /3 times a day/);
  assert.equal(faucetDecide({ address: B, sats: 1000, ip: '5.5.5.5' }, busy, { nowMs: now + DAY_MS }).ok, true, 'the next UTC day it pays again');
  assert.match(faucetDecide({ address: B, sats: 50000, ip: '6.6.6.6' }, book, { nowMs: now, dayCapSats: 100000 }).why, /today's coins/);
  assert.match(faucetDecide({ address: B, sats: 50000, ip: '6.6.6.6' }, { paid: [] }, { nowMs: now, balanceSats: 40000 }).why, /out of coins/);
});
