// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// BUY ADD-ONS INSIDE UNITY (2026-10-16): the page hands Unity its add-ons (ARENA_ADDONS_VIEW), buys through the
// kanban #3699 (report #463): the Next Block shop's Buy was drawn on while no paid round of the game was listed, and the purchase could
// only end "no paid round of this game is listed to read its donation sets from". Now the purchase reads a paid round from the game's own
// seats when the lobby lists none (as the donate popup does), and the shop draws Buy off, saying why, while there is none anywhere.
// Runs the page's own openShop and buyShopItem (index.html) with the world around them stubbed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const PAGE = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
const fnSrc = (head) => {
  const at = PAGE.indexOf(head); if (at < 0) return '';
  let d = 0;
  for (let i = PAGE.indexOf('{', at); i < PAGE.length; i++) { if (PAGE[i] === '{') d++; else if (PAGE[i] === '}' && --d === 0) return PAGE.slice(at, i + 1); }
  return '';
};
const GAME = { id: 'g1', name: 'nextblock', nodes: ['https://s1', 'https://s2'], manifest: { gameName: 'nextblock' } };
const SHOP = { game: GAME, items: [{ id: 'large-truck', name: 'Large truck', priceSat: 500n }] };
const ROW = { id: 'ab'.repeat(32), contract: { censusHeight: 7 }, free: false, game: 'g1', said: [{ node: 'https://s1' }] };

function world({ seatsRow }) {
  const seen = { seatAsks: 0, draws: [], said: [], bought: null };
  const window = { ARENA_GAMES_FULL: [GAME], ARENA_LOBBY: [], ARENA_LOBBY_ROWS: [], ARENA_GAME_CHOSEN: GAME,
    ARENA_ITEMS_SHARE: () => 50, ARENA_ITEM_PRICE: (p) => BigInt(p), ARENA_CENSUS_KEYS: async () => new Set(['k']),
    ARENA_WALLETS: new Map([['fed', { balanceMsat: async () => 10n ** 9n, paySubmit() {} }]]),
    ArenaText: { say: (el, t) => { el.text = t; } }, ArenaShop: { draw: (host, props) => seen.draws.push(props) } };
  const state = { classList: { toggle() {} }, set text(t) { seen.said.push(t); } };
  const sheet = { classList: { add() {} }, querySelector: (q) => (q === '.state' ? state : {}) };
  const document = { getElementById: (id) => (id === 'arena-shop' ? sheet : null) };
  const ARENACLIENT = { shopOf: () => SHOP, fromHex: (h) => h,
    fetchDonationSet: async () => ({ ok: true, target: { network: 'NET', game: 'GAME' } }),
    buyItem: async (o) => { seen.bought = o; return { ok: true, txid: 'tx' }; } };
  const stubs = { window, document, ARENACLIENT, itemsKey: () => ({ pubkey: 'p', sign() {} }), vault: () => ({}), pageEd25519Verify() {}, addons: {},
    itemsOwnedNow: async () => [], itemsUse: () => null, setItemsUse() {}, ITEM_PICTURE: {}, ITEM_WHAT: {},
    paidRoundFromSeats: async (games) => { seen.seatAsks++; assert.deepEqual(games.map((g) => g.id), ['g1'], 'the shop game\'s own seats'); return seatsRow; },
    fetch: async () => { throw new Error('no network'); } };
  const src = ['async function openShop(', 'async function buyShopItem(', 'async function shopPaidRows('].map(fnSrc).join('\n');
  const made = new Function(...Object.keys(stubs), `${src}\nreturn { openShop, buyShopItem };`)(...Object.values(stubs));
  return { ...made, seen, window };
}

test('#3699 no paid round in the lobby: the purchase reads one from the game\'s seats and buys', async () => {
  const w = world({ seatsRow: ROW });
  const got = await w.buyShopItem(SHOP, SHOP.items[0]);
  assert.equal(got.why, undefined, 'not refused for want of a listed round');
  assert.equal(got.ok, true);
  assert.deepEqual([w.seen.bought.networkSet, w.seen.bought.gameSet], ['NET', 'GAME']);
  assert.ok(w.seen.seatAsks >= 1);
});

test('#3699 no paid round anywhere: the shop draws Buy off and says why before any click', async () => {
  const w = world({ seatsRow: null });
  await w.openShop();
  const last = w.seen.draws[w.seen.draws.length - 1];
  assert.equal(last.items, SHOP.items);
  assert.match(String(last.closed || ''), /buying opens when a paid round of this game is listed/i, 'Buy is drawn off with the reason');
  assert.ok(w.seen.said.some((t) => /buying opens when a paid round of this game is listed/i.test(t)), 'the shop says it');
  const open = world({ seatsRow: ROW });
  await open.openShop();
  assert.equal(open.seen.draws[open.seen.draws.length - 1].closed, null, 'a round on the seats: Buy on');
});
