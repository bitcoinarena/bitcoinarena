// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 round 13 (faucet): THE NODE FAUCET'S PER-ADDRESS LIMIT IS NO LIMIT. faucetDecide (POST /faucet, on-chain tb1 coins for a new node's bond)
// counts "one internet address" by the raw string of book rows (p.ip === ask.ip), never by ipKey as every other faucet limit since #1405: an IPv6 caller
// holds a whole /64 and sends each request from another address of it, so FAUCET_PER_IP_PER_DAY never trips. And even one plain IPv4 address is let take
// the whole day: 30 requests a day of up to 1,500,000 sat is 45M, above the 30M day cap - 20 requests of the maximum take every coin of the day, and every
// new node operator's installer is told "the faucet has given out today's coins" until UTC midnight.
// Safe: the per-address count is by ipKey (an IPv6 /64 is one address), and one address cannot take the whole day's cap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { faucetDecide, FAUCET_MAX_SATS, FAUCET_DAY_CAP_SATS, FAUCET_PER_IP_PER_DAY } from '../src/faucet.js';

const CS = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const addr = (i) => { let s = ''; for (let n = i, k = 0; k < 38; k++, n = Math.floor(n / 32)) s = CS[n % 32] + s; return `tb1q${s}`; };
const NOW = Date.UTC(2026, 10, 12, 12);

test('#1489-r13 node faucet: one IPv6 /64 is one address for the per-address daily limit', () => {
  const book = { paid: [] };
  let paid = 0;
  for (let i = 0; i < FAUCET_PER_IP_PER_DAY + 10; i++) {
    const d = faucetDecide({ address: addr(1000 + i), sats: 1000, ip: `2001:db8:aa:bb::${(i + 1).toString(16)}` }, book, { nowMs: NOW });
    if (!d.ok) break;
    book.paid.push({ address: addr(1000 + i), ip: `2001:db8:aa:bb::${(i + 1).toString(16)}`, sats: d.sats, atMs: NOW });
    paid++;
  }
  console.log('  MEASURED:', JSON.stringify({ oneSlash64Paid: paid, perIpPerDay: FAUCET_PER_IP_PER_DAY }));
  assert.ok(paid <= FAUCET_PER_IP_PER_DAY, `one /64 was paid ${paid} times, the limit is ${FAUCET_PER_IP_PER_DAY}`);
});

test('#1489-r13 node faucet: one address cannot take the whole day cap', () => {
  const book = { paid: [] };
  let sats = 0, n = 0;
  for (let i = 0; i < 40; i++) {
    const d = faucetDecide({ address: addr(5000 + i), sats: FAUCET_MAX_SATS, ip: '203.0.113.7' }, book, { nowMs: NOW });
    if (!d.ok) break;
    book.paid.push({ address: addr(5000 + i), ip: '203.0.113.7', sats: d.sats, atMs: NOW });
    sats += d.sats; n++;
  }
  const other = faucetDecide({ address: addr(9999), sats: 100000, ip: '198.51.100.9' }, book, { nowMs: NOW });
  console.log('  MEASURED:', JSON.stringify({ oneIpRequests: n, oneIpSats: sats, dayCap: FAUCET_DAY_CAP_SATS, nextHonestNode: other }));
  assert.ok(sats < FAUCET_DAY_CAP_SATS, `one address took ${sats} of the day's ${FAUCET_DAY_CAP_SATS} sat`);
  assert.equal(other.ok, true, 'a new node operator after him is still paid the same day');
});
