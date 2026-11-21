// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 round r11 (client): ownedItems (#1558) counts a purchase by its id only and keeps the FIRST seat's record as it is.
// One seat, first in the list, names the player's real purchase id with another itemId; one honest seat names it right, so it is
// counted twice and the liar's itemId is kept. entryItemsFor then signs an entry naming an item the player never bought: every
// seat refuses that entry (round.js: "is not one this seat keeps for this game"), so one seat blocks every join with items.
// Safe: the record kept is one the agreeing seats name with the same itemId (or the purchase is not kept).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '../../arena-node/node_modules/@noble/curves/secp256k1.js';
import { ownedItems, entryItemsFor, itemsKeyFor } from '../src/item-buy.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const MANIFEST = { gameDevPubkey: b32(0xde), gameName: 'nextblock', requiredProtocolVersion: 10,
  items: [{ id: 'large-truck', name: 'Larger truck', priceSat: 500n, unlock: b32(0xa1) }, { id: 'small-boost', name: 'Boost', priceSat: 50n, unlock: b32(0xa2) }] };
const PID = 'ab'.repeat(32);
const CURVE = { pointX: (sk) => schnorr.getPublicKey(sk), signSchnorr: (m, sk) => schnorr.sign(m, sk) };

test('one seat cannot rename the item of a purchase the other seats name', async () => {
  const fetch = async (url) => {
    const host = new URL(url).host;
    const itemId = host === 'evil' ? 'large-truck' : 'small-boost';   // the player bought the boost
    return { ok: true, json: async () => ({ items: [{ id: PID, itemId, gameName: 'nextblock' }] }) };
  };
  const owned = await ownedItems({ seats: ['https://evil', 'https://s2'], player: b32(1), gameName: 'nextblock', fetch });
  const key = itemsKeyFor(b32(0x42), CURVE);
  const items = entryItemsFor({ round: { protocolVersion: 10 }, roundId: b32(1), playerPubkey: b32(2), owned, manifest: MANIFEST, key });
  assert.deepEqual(items.map((i) => i.itemId).filter((x) => x === 'large-truck'), [],
    `the entry names purchase ${PID.slice(0, 8)} as "large-truck" (one seat's word): every seat refuses the entry - owned ${JSON.stringify(owned)}`);
});
