// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1405 (audit 5 #1399): with the 2026-11-09 limits (200 grants per address, 10M sat a day) one IPv6 line - a whole /64 - could take the
// players' day in minutes with fresh addresses and fresh accounts. Now an IPv6 address counts by its /64 and all players take at most 2M sat an hour.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { playerGrantDecide, ipKey, PLAYER_PER_IP_PER_DAY, PLAYER_HOUR_CAP_SATS, PLAYER_DAY_CAP_SATS, PLAYER_GRANTS } from '../src/faucet.js';

const acct = (n) => n.toString(16).padStart(64, '0');
const T0 = Date.UTC(2026, 10, 10, 1, 0, 0);
const drain = ({ ipFor, minutes = 10 }) => {
  const book = { players: [] }; let paid = 0, refusedWhy = new Map();
  for (let i = 0; i < 4000; i++) {
    const nowMs = T0 + Math.floor((i * minutes * 60000) / 4000);
    const d = playerGrantDecide({ kind: 'welcome', account: acct(i + 1), ip: ipFor(i), invoiceSats: PLAYER_GRANTS.welcome.invoiceSats, nowMs }, book);
    if (d.ok) { book.players.push({ account: acct(i + 1), kind: 'welcome', ip: ipFor(i), sats: d.grant.sats, atMs: nowMs }); paid += d.grant.sats; }
    else refusedWhy.set(d.why, (refusedWhy.get(d.why) || 0) + 1);
  }
  return { paid, refusedWhy: Object.fromEntries(refusedWhy) };
};

test('#1405 one IPv6 /64 with a fresh address and account per ask takes 200 welcomes, not the day', () => {
  const r = drain({ ipFor: (i) => `2001:db8:1:2:${(i >> 16).toString(16)}:${(i & 0xffff).toString(16)}:0:1` });
  console.log(`  MEASURED #1405: one /64, 4000 fresh addresses in 10 min: ${r.paid} sat paid; refused ${JSON.stringify(r.refusedWhy)}`);
  assert.equal(r.paid, PLAYER_PER_IP_PER_DAY * PLAYER_GRANTS.welcome.sats);
});

test('#1405 many different /64s still take at most 2M sat an hour; the day cap stays 10M', () => {
  const r = drain({ ipFor: (i) => `2001:db8:${(i >> 8).toString(16)}:${(i & 255).toString(16)}::1` });
  console.log(`  MEASURED #1405: 4000 different /64s in 10 min: ${r.paid} sat paid; refused ${JSON.stringify(r.refusedWhy)}`);
  assert.ok(r.paid <= PLAYER_HOUR_CAP_SATS && r.paid > PLAYER_HOUR_CAP_SATS - PLAYER_GRANTS.welcome.sats);
  assert.equal(PLAYER_DAY_CAP_SATS, 10000000);
});

test('#1405 ipKey: an IPv6 address by its /64 whatever its spelling; IPv4 and IPv4-mapped as IPv4', () => {
  assert.equal(ipKey('2001:db8:1:2::1'), ipKey('2001:0db8:0001:0002:ffff:0:0:9'));
  assert.notEqual(ipKey('2001:db8:1:2::1'), ipKey('2001:db8:1:3::1'));
  assert.equal(ipKey('::ffff:192.0.2.7'), '192.0.2.7');
  assert.equal(ipKey('[2001:db8::1]'), ipKey('2001:db8::2'));
  assert.equal(ipKey(''), null);
});
