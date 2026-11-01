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

test('the players\' faucet: a welcome once, three top-ups a day, an IP and a day capped, and only its own invoice amount', async () => {
  const { playerGrantDecide: d, playerGrantTotals, PLAYER_GRANTS, PLAYER_PER_IP_PER_DAY, PLAYER_DAY_CAP_SATS } = await import('../src/faucet.js');
  const a = 'a'.repeat(64), b = 'b'.repeat(64), now = 86400000 * 20758 + 1000, W = PLAYER_GRANTS.welcome.invoiceSats, T = PLAYER_GRANTS.topup.invoiceSats;
  const ask = (kind, account, extra = {}) => ({ kind, account, ip: '1.1.1.1', invoiceSats: kind === 'welcome' ? W : T, nowMs: now, ...extra });
  const row = (kind, account, extra = {}) => ({ kind, account, ip: '2.2.2.2', sats: kind === 'welcome' ? W : T, atMs: now, ...extra });
  assert.equal(d(ask('welcome', a), { players: [] }).ok, true);
  assert.equal(d(ask('welcome', a), { players: [row('welcome', a, { atMs: now - 86400000 * 9 })] }).ok, false, 'a welcome twice');
  assert.equal(d(ask('welcome', a, { invoiceSats: 100000 }), { players: [] }).ok, false, 'another amount');
  assert.equal(d(ask('free', a), { players: [] }).ok, false);
  assert.equal(d(ask('__proto__', a), { players: [] }).ok, false);
  assert.equal(d(ask('topup', 'nope'), { players: [] }).ok, false);
  assert.equal(d(ask('topup', a), { players: [row('topup', a), row('topup', a)] }).ok, true);
  assert.equal(d(ask('topup', a), { players: [row('topup', a), row('topup', a), row('topup', a)] }).ok, false, 'a fourth top-up');
  assert.equal(d(ask('topup', a, { nowMs: now + 86400000 }), { players: [row('topup', a), row('topup', a), row('topup', a)] }).ok, true, 'the next day');
  assert.equal(d(ask('topup', a), { players: Array.from({ length: PLAYER_PER_IP_PER_DAY }, () => row('topup', b, { ip: '1.1.1.1' })) }).ok, false, 'one address');
  assert.equal(d(ask('topup', a, { ip: null }), { players: [row('topup', b, { sats: PLAYER_DAY_CAP_SATS })] }).ok, false, 'the day cap');
  const t = playerGrantTotals({ players: [row('welcome', a), row('welcome', b, { atMs: now - 86400000 }), row('topup', a), row('topup', a)] }, now);
  assert.deepEqual([t.newAccounts.grants, t.newAccounts.sats, t.newAccounts.today.grants, t.returning.grants, t.returning.accounts, t.totalSats], [2, 2 * W, 1, 2, 1, 2 * W + 2 * T]);
  assert.equal(JSON.stringify(t).includes(a), false, 'no account in the totals');
});
