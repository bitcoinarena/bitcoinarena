// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 r20-faucet-1 (players' faucet, role (d): a stranger, P4/P5; the hour, not the day of #2757/#2827): PLAYER_HOUR_CAP_SATS is one
// pool for every player, and the per-network share (#2757) and the new-network reserve (#2827) count only the day. One IPv4 /24 (12 addresses,
// accounts cost nothing) asks 667 welcomes in the first minutes of each hour and takes the whole 2,000,000 sat hour; every honest new player
// from any other network is then refused "the faucet gave all it gives this hour" for the rest of that hour - 2.5 hours a day per /24 until its
// day share runs out, then a second /24 takes over.
// Safe: one network cannot take all of an hour's welcome sats - a player from another network is still paid that hour.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { playerGrantDecide, DAY_MS } from '../src/faucet.js';

test('#1489 r20-faucet-1: one /24 does not take the whole hour of welcome sats', () => {
  const day0 = Math.floor(Date.now() / DAY_MS) * DAY_MS;
  const book = { players: [], unsure: [] };
  const honest = [], took = [];
  for (let hour = 0; hour < 2; hour++) {
    let n = 0;
    for (let s = 0; s < 900; s++) {
      const nowMs = day0 + hour * 3600000 + s * 1000, ip = `198.51.100.${(s % 12) + 1}`, account = randomBytes(32).toString('hex');
      const d = playerGrantDecide({ kind: 'welcome', account, ip, invoiceSats: 3000, nowMs }, book);
      if (d.ok) { book.players.push({ account, kind: 'welcome', ip, sats: d.grant.invoiceSats, atMs: nowMs }); n += d.grant.invoiceSats; }
    }
    took.push(n);
    for (let i = 1; i <= 3; i++) {
      const account = randomBytes(32).toString('hex'), ip = `192.0.${hour * 10 + i}.77`, nowMs = day0 + hour * 3600000 + 30 * 60000 + i * 60000;
      const d = playerGrantDecide({ kind: 'welcome', account, ip, invoiceSats: 3000, nowMs }, book);
      if (d.ok) book.players.push({ account, kind: 'welcome', ip, sats: d.grant.invoiceSats, atMs: nowMs });
      honest.push(d.ok ? 'paid' : d.why);
    }
  }
  console.log(`  MEASURED one /24 took ${JSON.stringify(took)} sat in the first 15 min of hours 0 and 1; six honest players from other networks at :31-:33: ${JSON.stringify(honest)}`);
  assert.deepEqual(honest, Array(6).fill('paid'), 'an honest new player from another network is paid in the same hour');
});
