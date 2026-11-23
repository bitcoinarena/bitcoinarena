// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 r23-faucet-2 (players' faucet, role: a stranger, P5; way round #2757): one network (an IPv6 /48 or an IPv4 /24) takes at most
// half of the day's welcome sats - so two networks take all of it. Two cheap VPS /24s asking welcomes for fresh accounts (accounts cost nothing)
// empty PLAYER_DAY_CAP_SATS in about five hours, and every honest new player of the day is refused "the faucet gave all it gives today".
// Safe: strangers holding a couple of networks cannot close the welcome to everyone else for the day.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { playerGrantDecide, DAY_MS } from '../src/faucet.js';

test('#1489 r23-faucet-2: two /24s do not take the whole day of welcome sats', () => {
  const day0 = Math.floor(Date.now() / DAY_MS) * DAY_MS;
  const book = { players: [], unsure: [] };
  let paid = 0;
  for (let min = 0; min < 12 * 60; min++) {
    const nowMs = day0 + min * 60000;
    for (const net of ['198.51.100', '203.0.113']) for (let host = 1; host <= 12; host++) {
      const ip = `${net}.${host}`, account = randomBytes(32).toString('hex');
      const d = playerGrantDecide({ kind: 'welcome', account, ip, invoiceSats: 3000, nowMs }, book);
      if (d.ok) { book.players.push({ account, kind: 'welcome', ip, sats: d.grant.invoiceSats, atMs: nowMs }); paid += d.grant.invoiceSats; }
    }
  }
  const honest = [];
  for (let i = 1; i <= 5; i++) {
    const account = randomBytes(32).toString('hex'), ip = `192.0.${i}.77`, nowMs = day0 + 13 * 3600000 + i * 60000;
    const d = playerGrantDecide({ kind: 'welcome', account, ip, invoiceSats: 3000, nowMs }, book);
    if (d.ok) book.players.push({ account, kind: 'welcome', ip, sats: d.grant.invoiceSats, atMs: nowMs });
    honest.push(d.ok ? 'paid' : d.why);
  }
  console.log(`  MEASURED two /24s took ${paid} sat of the day; five honest new players from five other networks from 13:00: ${JSON.stringify(honest)}`);
  assert.deepEqual(honest, Array(5).fill('paid'), 'honest new players from other networks still get their welcome');
});
