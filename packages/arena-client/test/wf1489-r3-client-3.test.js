// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 round 3: ONE SEAT DECIDES WHICH PAID ITEMS A PLAYER OWNS. ownedItems returns the FIRST seat's GET /items answer as it is: a
// seat listed first that answers { items: [] } hides every item the player paid for (the entry then plays without it), and one that
// answers a made-up purchase id for the item has the entry name a purchase no other seat holds. Safe: what the seats answer is merged, so
// a purchase the other seats keep is still the player's, whatever the first seat says.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ownedItems } from '../src/item-buy.js';

const PLAYER = new Uint8Array(32).fill(0x42);
const REAL = { id: '11'.repeat(32), gameName: 'btc-logistics', itemId: 'large-truck' };

test('a paid item stays owned when the first seat asked answers an empty list', async () => {
  const fetch = async (u) => {
    if (u.startsWith('https://bad.example')) return new Response(JSON.stringify({ items: [] }), { status: 200 });
    return new Response(JSON.stringify({ items: [REAL] }), { status: 200 });
  };
  const got = await ownedItems({ seats: ['https://bad.example', 'https://a.example', 'https://b.example', 'https://c.example'], player: PLAYER,
    gameName: 'btc-logistics', fetch });
  console.log(`  owned: ${JSON.stringify(got)}`);
  assert.ok(got.some((o) => o.id === REAL.id), 'the purchase three seats keep is the player\'s');
});
