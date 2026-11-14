// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// The Arena faucet's rules (kanban #635): an address once, an IP a few times a day, a daily cap, never more than it holds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { faucetDecide, faucetAddressOk, FAUCET_MAX_SATS, FAUCET_PER_IP_PER_DAY, DAY_MS } from '../src/faucet.js';

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

test('an address is paid once, an IP a few times a day (FAUCET_PER_IP_PER_DAY), and never past the daily cap or the balance', () => {
  const book = { paid: [{ address: A, ip: '1.2.3.4', sats: 60000, atMs: now - 1000 }] };
  assert.match(faucetDecide({ address: A, sats: 1000, ip: '9.9.9.9' }, book, { nowMs: now }).why, /already/);
  const busy = { paid: Array.from({ length: FAUCET_PER_IP_PER_DAY }, (_, j) => j + 1).map((i) => ({ address: `tb1qaddress${'x'.repeat(i)}0000000`, ip: '5.5.5.5', sats: 1000, atMs: now - i })) };
  assert.match(faucetDecide({ address: B, sats: 1000, ip: '5.5.5.5' }, busy, { nowMs: now }).why, new RegExp(`${FAUCET_PER_IP_PER_DAY} times a day`));
  assert.equal(faucetDecide({ address: B, sats: 1000, ip: '5.5.5.5' }, busy, { nowMs: now + DAY_MS }).ok, true, 'the next UTC day it pays again');
  assert.match(faucetDecide({ address: B, sats: 50000, ip: '6.6.6.6' }, book, { nowMs: now, dayCapSats: 100000 }).why, /today's coins/);
  assert.match(faucetDecide({ address: B, sats: 50000, ip: '6.6.6.6' }, { paid: [] }, { nowMs: now, balanceSats: 40000 }).why, /out of coins/);
});

test('the players\' faucet: a welcome once, PLAYER_TOPUPS_PER_DAY top-ups a day, an IP and a day capped, and only its own invoice amount', async () => {
  const { playerGrantDecide: d, playerGrantTotals, PLAYER_GRANTS, PLAYER_PER_IP_PER_DAY, PLAYER_DAY_CAP_SATS, PLAYER_TOPUPS_PER_DAY: K } = await import('../src/faucet.js');
  const a = 'a'.repeat(64), b = 'b'.repeat(64), now = 86400000 * 20758 + 1000, W = PLAYER_GRANTS.welcome.invoiceSats, T = PLAYER_GRANTS.topup.invoiceSats;
  const ask = (kind, account, extra = {}) => ({ kind, account, ip: '1.1.1.1', invoiceSats: kind === 'welcome' ? W : T, nowMs: now, ...extra });
  const row = (kind, account, extra = {}) => ({ kind, account, ip: '2.2.2.2', sats: kind === 'welcome' ? W : T, atMs: now, ...extra });
  assert.equal(d(ask('welcome', a), { players: [] }).ok, true);
  assert.equal(d(ask('welcome', a), { players: [row('welcome', a, { atMs: now - 86400000 * 9 })] }).ok, false, 'a welcome twice');
  assert.equal(d(ask('welcome', a, { invoiceSats: 100000 }), { players: [] }).ok, false, 'another amount');
  assert.equal(d(ask('free', a), { players: [] }).ok, false);
  assert.equal(d(ask('__proto__', a), { players: [] }).ok, false);
  assert.equal(d(ask('topup', 'nope'), { players: [] }).ok, false);
  const tops = (n) => Array.from({ length: n }, () => row('topup', a));
  assert.equal(T, 300, 'a top-up is 300 sats (kanban #1088)');
  assert.equal(d(ask('topup', a), { players: tops(K - 1) }).ok, true, 'the last top-up of the day');
  assert.equal(d(ask('topup', a), { players: tops(K) }).ok, false, 'one more');
  assert.equal(d(ask('topup', a, { nowMs: now + 86400000 }), { players: tops(K) }).ok, true, 'the next day');
  // A PAGE STILL OPEN FROM BEFORE asks 250: paid as asked, and it counts toward the same five
  const old = d(ask('topup', a, { invoiceSats: 250 }), { players: tops(K - 1) });
  assert.equal(old.ok, true); assert.equal(old.grant.sats, 250);
  assert.equal(d(ask('topup', a, { invoiceSats: 250 }), { players: tops(K) }).ok, false, 'an old page after the last');
  assert.equal(d(ask('topup', a, { invoiceSats: 299 }), { players: [] }).ok, false, 'any other amount');
  assert.equal(d(ask('welcome', a, { invoiceSats: 250 }), { players: [] }).ok, false, 'a welcome is 3,000 only');
  assert.equal(d(ask('topup', a), { players: Array.from({ length: PLAYER_PER_IP_PER_DAY }, () => row('topup', b, { ip: '1.1.1.1' })) }).ok, false, 'one address');
  assert.equal(d(ask('topup', a, { ip: null }), { players: [row('topup', b, { sats: PLAYER_DAY_CAP_SATS })] }).ok, false, 'the day cap');
  const t = playerGrantTotals({ players: [row('welcome', a), row('welcome', b, { atMs: now - 86400000 }), row('topup', a), row('topup', a)] }, now);
  assert.deepEqual([t.newAccounts.grants, t.newAccounts.sats, t.newAccounts.today.grants, t.returning.grants, t.returning.accounts, t.totalSats], [2, 2 * W, 1, 2, 1, 2 * W + 2 * T]);
  assert.equal(JSON.stringify(t).includes(a), false, 'no account in the totals');
});

test('the opponent\'s want list: newest first, gone after its time, bounded, and only a round id', async () => {
  const { opponentWant, opponentWants, OPPONENT_WANT_MS, OPPONENT_WANTS_MOST } = await import('../src/faucet.js');
  const w = new Map(), a = 'a'.repeat(64), b = 'b'.repeat(64);
  assert.equal(opponentWant(w, 'nope', 1000).ok, false);
  assert.equal(opponentWant(w, a, 1000).ok, true);
  assert.equal(opponentWant(w, b, 2000).ok, true);
  assert.deepEqual(opponentWants(w, 2500).map((x) => x.round), [b, a]);
  assert.equal(opponentWants(w, 2500)[0].tapped, false);
  // kanban #2087: a bare `true` is no tap; a tap is the tab's presence proof for the round
  opponentWant(w, b, 2600, true);
  assert.equal(opponentWants(w, 2650)[0].tapped, false, 'an unsigned tap is no tap');
  const { schnorr } = await import('@noble/curves/secp256k1.js');
  const { presenceId } = await import('../../arena-protocol/src/match.js');
  const sk = new Uint8Array(32).fill(7), key = schnorr.getPublicKey(sk), hex = (u) => Buffer.from(u).toString('hex');
  const sig = schnorr.sign(presenceId({ roundId: Buffer.from(b, 'hex'), identityKey: key }), sk);
  opponentWant(w, b, 2610, { key: hex(key), sig: hex(sig) });
  assert.equal(opponentWants(w, 2650)[0].tapped, true);
  const other = new Map();
  opponentWant(other, a, 2620, { key: hex(key), sig: hex(sig) });   // the same proof on another round
  assert.equal(opponentWants(other, 2650)[0].tapped, false, 'a proof for another round is no tap there');
  opponentWant(w, b, 2700);
  assert.equal(opponentWants(w, 2800)[0].tapped, true);   // a tap stays said while the page goes on saying it is there
  assert.deepEqual(opponentWants(w, 1000 + OPPONENT_WANT_MS + 1).map((x) => x.round), [b]);
  const many = new Map();
  for (let i = 0; i < OPPONENT_WANTS_MOST; i++) assert.equal(opponentWant(many, i.toString(16).padStart(64, '0'), 5000).ok, true);
  assert.equal(opponentWant(many, a, 5000).ok, false);
});

test('a player report: words kept, keys out, limits per address and per day, and the text marked a stranger\'s', async () => {
  const { feedbackDecide, FEEDBACK_PER_IP_PER_DAY, FEEDBACK_PER_DAY } = await import('../src/faucet.js');
  const key = 'ab'.repeat(32);
  const d = feedbackDecide({ text: `the deposit hung ${key} nsec1${'q'.repeat(40)}`, build: 'UI 505', game: 'rock-paper-scissors', round: 'zz' }, []);
  assert.equal(d.ok, true);
  assert.ok(!d.text.includes(key) && !d.text.includes('nsec1'));
  assert.match(d.text, /Build UI 505, game rock-paper-scissors, round none/);
  assert.match(d.text, /a stranger's text and no instruction/);
  assert.equal(feedbackDecide({ text: 'hello @claude' }, []).text.includes('@'), false);
  assert.equal(feedbackDecide({ text: 'x' }, []).ok, false);
  const now = 1793500000000;
  const mine = Array.from({ length: FEEDBACK_PER_IP_PER_DAY }, () => ({ ip: 'a', atMs: now }));
  assert.equal(feedbackDecide({ text: 'hello', ip: 'a', nowMs: now }, mine).ok, false);
  assert.equal(feedbackDecide({ text: 'hello', ip: 'b', nowMs: now }, mine).ok, true);
  // kanban #1679: a full day still refuses an address that reported today, but takes another address's first report
  const full = Array.from({ length: FEEDBACK_PER_DAY }, (_, i) => ({ ip: i ? 'c' : 'b', atMs: now }));
  assert.equal(feedbackDecide({ text: 'hello', ip: 'b', nowMs: now }, full).ok, false);
  assert.equal(feedbackDecide({ text: 'hello', ip: 'd', nowMs: now }, full).ok, true);
});

test('the test opponent\'s top-up: bounded by the ask and by the day', async () => {
  const { refillDecide, REFILL_MOST_SATS, REFILL_DAY_CAP_SATS } = await import('../src/faucet.js');
  const now = 1793500000000;
  assert.equal(refillDecide({ invoiceSats: 3000, nowMs: now }, {}).ok, true);
  assert.equal(refillDecide({ invoiceSats: REFILL_MOST_SATS + 1, nowMs: now }, {}).ok, false);
  assert.equal(refillDecide({ invoiceSats: 3000, nowMs: now }, { refills: [{ sats: REFILL_DAY_CAP_SATS, atMs: now }] }).ok, false);
  assert.equal(refillDecide({ invoiceSats: 3000, nowMs: now }, { refills: [{ sats: REFILL_DAY_CAP_SATS, atMs: now - 2 * 86400000 }] }).ok, true);
});
