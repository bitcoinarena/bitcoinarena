// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 round 22 (faucet): THE NODE FAUCET'S NETWORK SHARE HOLDS ONLY FOR IPv6 (bypass of #2539). faucetDecide bounds one address at a quarter of the
// day (FAUCET_ADDRESS_SHARE) and one IPv6 /48 at a half (FAUCET_NET48_SHARE), but an IPv4 caller has no enclosing network: net48() of an IPv4 key is null.
// Four IPv4 addresses of one /24 (one VPS block) take 4 x 7.5M = the whole 30M day in 20 requests, and every new node's installer is refused until midnight.
// The players' faucet bounds an IPv4 /24 like an IPv6 /48 since #2757; the node faucet does not. Safe: one IPv4 /24 takes at most half the day too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { faucetDecide, FAUCET_MAX_SATS, FAUCET_DAY_CAP_SATS } from '../src/faucet.js';

const CS = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const addr = (i) => { let s = ''; for (let n = i, k = 0; k < 38; k++, n = Math.floor(n / 32)) s = CS[n % 32] + s; return `tb1q${s}`; };
const NOW = Date.UTC(2026, 10, 15, 2);

test('#1489-r22 node faucet: one IPv4 /24 cannot take the whole day (as an IPv6 /48 cannot)', () => {
  const book = { paid: [] };
  let sats = 0, n = 0;
  for (let i = 0; i < 40; i++) {
    const ip = `203.0.113.${1 + (i % 4)}`;
    const d = faucetDecide({ address: addr(7000 + i), sats: FAUCET_MAX_SATS, ip }, book, { nowMs: NOW + i * 1000 });
    if (!d.ok) continue;
    book.paid.push({ address: addr(7000 + i), ip, sats: d.sats, atMs: NOW + i * 1000 });
    sats += d.sats; n++;
  }
  const honest = faucetDecide({ address: addr(99999), sats: 100000, ip: '198.51.100.9' }, book, { nowMs: NOW + 60000 });
  console.log('  MEASURED:', JSON.stringify({ slash24Requests: n, slash24Sats: sats, dayCap: FAUCET_DAY_CAP_SATS, nextHonestNode: honest }));
  assert.ok(sats <= Math.floor(FAUCET_DAY_CAP_SATS / 2), `four addresses of one IPv4 /24 took ${sats} of the day's ${FAUCET_DAY_CAP_SATS} sat`);
  assert.equal(honest.ok, true, 'a new node operator after them is still paid the same day');
});
