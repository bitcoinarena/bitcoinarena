// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2757, #1489 r7 faucet 1 (P5, a way round #2539 at the other faucet door): the node faucet (faucetDecide) caps one address at a quarter of the day
// and one IPv6 /48 at half since #2539. The players' faucet (playerGrantDecide, POST /player welcome) counts only PLAYER_PER_IP_PER_DAY (200) per
// ipKey (one /64) and the global day/hour caps; an account is any 64 hex, so it is free. One home line's /56 holds 256 /64s: 17 of them, each with
// 200 fresh accounts, take the whole PLAYER_DAY_CAP_SATS (10M sat = 3,333 welcomes) - paced under the hour cap, in about 5.5 hours - and every
// honest new player is then told "the faucet gave all it gives today" until UTC midnight.
// Safe: one IPv6 /48 (or one IPv4 /24) takes at most half of the players' day cap, as the node faucet's FAUCET_NET48_SHARE.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { playerGrantDecide, PLAYER_DAY_CAP_SATS, DAY_MS } from '../src/faucet.js';

function drain(ipOf) {
  const book = { players: [] };
  const day0 = Math.floor(Date.UTC(2026, 10, 20) / DAY_MS) * DAY_MS;
  let n = 0, took = 0, lastWhy = null;
  for (let i = 0; i < 4000; i++) {
    const nowMs = day0 + i * 6000;   // 600 an hour: under PLAYER_HOUR_CAP_SATS (666 welcomes an hour)
    const account = (i + 1).toString(16).padStart(64, '0');
    const ip = ipOf(Math.floor(i / 200));   // a fresh /64 (or IPv4) every 200 welcomes
    const d = playerGrantDecide({ kind: 'welcome', account, ip, invoiceSats: 3000, nowMs }, book);
    if (!d.ok) { lastWhy = d.why; continue; }
    book.players.push({ account, kind: 'welcome', ip, sats: d.grant.invoiceSats, atMs: nowMs, hash: account });
    n++; took += d.grant.invoiceSats;
  }
  return { n, took, lastWhy };
}

test('#1489-r7-faucet-1 one IPv6 /48 does not take the players\' whole day of welcomes', () => {
  const r = drain((k) => `2001:db8:77:${(0x100 + k).toString(16)}::1`);   // /64s of one /48 (one /56 even)
  console.log('  MEASURED:', JSON.stringify({ welcomes: r.n, sats: r.took, dayCap: PLAYER_DAY_CAP_SATS, lastWhy: r.lastWhy }));
  assert.ok(r.took <= PLAYER_DAY_CAP_SATS / 2, `one /48 took ${r.took} of the ${PLAYER_DAY_CAP_SATS} sat the players' faucet gives a day`);
});

test('#1489-r7-faucet-1 one IPv4 /24 does not take the players\' whole day of welcomes', () => {
  const r = drain((k) => `198.51.100.${10 + k}`);
  console.log('  MEASURED:', JSON.stringify({ welcomes: r.n, sats: r.took, dayCap: PLAYER_DAY_CAP_SATS, lastWhy: r.lastWhy }));
  assert.ok(r.took <= PLAYER_DAY_CAP_SATS / 2, `one /24 took ${r.took} of the ${PLAYER_DAY_CAP_SATS} sat the players' faucet gives a day`);
});
