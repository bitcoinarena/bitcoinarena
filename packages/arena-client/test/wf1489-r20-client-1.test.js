// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r20 client-1: ONE SEAT CLAIMING ANOTHER SEAT'S NODE KEY DROPS THAT SEAT FROM THE GAME'S NODES, AND THE SHOP THEN HANDS A
// PAID ITEM'S RECORD TO THE LIAR ALONE. fetchGames (games.js) counts a node once per `body.node` - a key the seat states in its own
// GET /games answer, signed by nobody. A seat listed before an honest one answers with the honest seat's (public) key: the honest
// address is skipped (`got.nodeKeys.has(key)`) and game.nodes is the liar alone. buyShopItem passes shop.game.nodes as the seats; buyItem
// pays, and handToSeats keeps the record on min(2, seats.length) = 1 answer - the liar's 200 - and drops it. No honest seat ever holds
// the purchase the player paid for.
// Safe: an address that answered and hosts the game is never dropped from game.nodes on another address's unsigned key claim.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchGames } from '../src/games.js';
import { handToSeats } from '../src/item-buy.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { encodeManifest } from '../../arena-protocol/src/manifest.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const answer = (body) => new Response(JSON.stringify(body), { status: 200 });
const genuine = { id: toHex(NEXTBLOCK.gameId), name: NEXTBLOCK.name, manifest: toHex(encodeManifest(NEXTBLOCK.manifest)) };
const HONEST_KEY = '5a'.repeat(32);

test('a seat naming the honest seat\'s key does not push the honest seat out of the game\'s nodes (and the shop\'s seats)', async () => {
  const lists = {
    'http://evil': { node: HONEST_KEY, games: [genuine] },          // the honest seat's key, read off the explorer
    'http://honest': { node: HONEST_KEY, games: [genuine] },
  };
  const fetcher = async (url) => answer(lists[url.replace(/\/games$/, '')]);
  const { games } = await fetchGames({ nodes: Object.keys(lists), fetcher });
  const g = games.find((x) => x.id === genuine.id);
  console.log('  game.nodes =', JSON.stringify(g.nodes));
  // what the shop does with them: the record of a paid purchase is handed to these seats
  const kept = [];
  const seatFetch = async (url) => { kept.push(url); return url.startsWith('http://evil') ? new Response('ok', { status: 200 }) : new Response('ok', { status: 200 }); };
  const h = await handToSeats({ seats: g.nodes, door: 'item-purchase', body: '{}', fetch: seatFetch });
  console.log('  record handed to', JSON.stringify(kept), 'keptBy', h.keptBy);
  assert.ok(g.nodes.includes('http://honest'), 'the honest seat answered and hosts the game: it stays among the game\'s nodes');
  assert.ok(kept.some((u) => u.startsWith('http://honest')), 'the paid record reaches the honest seat');
});
