// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3668 (found in feedback #456): round ed43c013 ran on Up/Down v24 (game id 8e47d27f) while the page already showed v26, and the page
// handed the client only the orders of the shown game id (ARENA_GAME.market.orders: x.gameId === game.id) - the player's order vanished from
// My orders and Past orders during the version change. Now every version of the shown game (its tile's: same developer key and name) counts,
// and another game's orders still do not. It runs as the page has it (src/arena-ui/index.html).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const HTML = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
const slice = (from, to) => { const a = HTML.indexOf(from), b = HTML.indexOf(to, a + from.length); return a < 0 || b < a ? null : HTML.slice(a, b); };
const familyLine = slice('window.ARENA_GAME_FAMILY = ', ';\n');
const ordersProp = slice('          orders: () => {', '          cancel: async (entryIdHex) => {');
assert.ok(ordersProp, 'ARENA_GAME.market.orders is not found');

const V26 = 'f8df58ed' + '0'.repeat(56), V24 = '8e47d27f' + '0'.repeat(56), V25 = '30d66419' + '0'.repeat(56), RPS = '5a1e0000' + '0'.repeat(56);
const DEV = 'dd'.repeat(32);
const tiles = [{ id: V26, name: 'btc-updown-15m', devKey: DEV, versions: [V26, V25, V24] }, { id: RPS, name: 'rock-paper-scissors', devKey: 'ee'.repeat(32), versions: [RPS] }];
const pick = (entry, gameId) => ({ roundIdHex: 'ed43c013' + entry, entryIdHex: entry, gameId, pick: 1, stakeMsat: '100000', entryCloseMs: 1, order: { limitPrice: 50000, orderExpiryMs: 0, placedMs: 1 } });
const picks = [pick('e26', V26), pick('e24', V24), pick('rps', RPS)];

const ordersOf = (game) => {
  const window = {};
  if (familyLine) new Function('window', 'game', 'tiles', familyLine + ';')(window, game, tiles);
  const market = new Function('readPicks', 'marketViewLines', 'QUIET_ORDERS', 'game', 'window', `return {\n${ordersProp}};`)(() => picks, () => [], new Set(), game, window);
  return market.orders().map((o) => o.entry);
};

test('#3668 an order in a round of the previous version is still the shown game\'s order', () => {
  // the shown game as a link names it: the tile (with its versions), or one version by its id (no versions of its own)
  const asTile = ordersOf(tiles[0]), asId = ordersOf({ id: V26, name: 'btc-updown-15m', devKey: DEV });
  console.log('#3668 MEASURED orders handed to the v26 client:', JSON.stringify({ asTile, asId }));
  assert.deepEqual(asTile, ['e26', 'e24'], 'the v24 order vanished while the page shows v26');
  assert.deepEqual(asId, ['e26', 'e24']);
});

test('#3668 another game\'s orders are still not handed', () => {
  assert.deepEqual(ordersOf(tiles[1]), ['rps']);
  // a same-name game under another developer key is not this game
  assert.deepEqual(ordersOf({ id: V26, name: 'btc-updown-15m', devKey: 'ff'.repeat(32) }), ['e26']);
});
