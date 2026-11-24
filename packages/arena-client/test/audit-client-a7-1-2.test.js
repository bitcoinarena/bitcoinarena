// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Audit 2026-11-24 client a7 r1 #2 (P4, P8, P11: gap in the #1558 / #2421 fix, the #3350 class at GET /items). ownedItems (item-buy.js:224)
// keeps a purchase when two seats name it - but "seats" are the entries of the list as given: the round link's node= list (the page's
// ARENA_ITEMS_FOR_ENTRY passes the round's named nodes) is not deduplicated at all, so one box listed as http://liar.test and
// http://liar.test/ is two seats. Its made-up purchase of 'large-truck' reaches `need`, entryItemsFor signs the entry with it (the page plays
// with every owned item by default), and every honest seat refuses the entry (round.js: "is not one this seat keeps for this game") - the
// player, who bought nothing, can join no paid round of the game through that link.
// SAFE: one box under two spellings is one seat's word; a purchase no honest seat names is not owned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '../../arena-node/node_modules/@noble/curves/secp256k1.js';
import { ownedItems, entryItemsFor, itemsKeyFor } from '../src/item-buy.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const MANIFEST = { gameDevPubkey: b32(0xde), gameName: 'nextblock', requiredProtocolVersion: 10,
  items: [{ id: 'large-truck', name: 'Larger truck', priceSat: 500n, unlock: b32(0xa1) }] };
const FAKE = 'ab'.repeat(32);
const CURVE = { pointX: (sk) => schnorr.getPublicKey(sk), signSchnorr: (m, sk) => schnorr.sign(m, sk) };

test('audit client a7 r1 #2: one box under two URL spellings does not make up an owned item', async () => {
  const fetch = async (url) => {
    const host = new URL(url).host;
    const items = host === 'liar.test' ? [{ id: FAKE, itemId: 'large-truck', gameName: 'nextblock' }] : [];   // the honest seats keep nothing for this player
    return { ok: true, json: async () => ({ items }) };
  };
  // control: the liar listed once is one word against two honest seats
  const once = await ownedItems({ seats: ['http://liar.test', 'http://a.test', 'http://b.test'], player: b32(1), gameName: 'nextblock', fetch });
  assert.deepEqual(once, []);
  const owned = await ownedItems({ seats: ['http://liar.test', 'http://liar.test/', 'http://a.test', 'http://b.test'], player: b32(1), gameName: 'nextblock', fetch });
  const key = itemsKeyFor(b32(0x42), CURVE);
  const items = entryItemsFor({ round: { protocolVersion: 10 }, roundId: b32(1), playerPubkey: b32(2), owned, use: owned.map((o) => o.itemId), manifest: MANIFEST, key });
  console.log('  FACTS a7-1-2:', JSON.stringify({ owned, entryItems: items.map((i) => i.itemId) }));
  assert.deepEqual(owned, [], 'one box named twice made up a purchase the honest seats do not keep: the entry names it and every seat refuses it');
});
