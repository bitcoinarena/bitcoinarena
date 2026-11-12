// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2243 (#1489 a45 refute 4, #1810 variant), the page's side: the item terms of the chosen tile (index.html itemsManifest) and the
// donation game key (donateSets' game pick) come from the tile's own developer key, never from a stranger's same-name manifest
// under a key of his own with a higher version.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageFunction } from './page-script.js';
import { itemTermsOf, itemShareOn, itemPriceOn, shopOf } from '../src/item-buy.js';
import { ITEM_DEV_SHARES } from '../../arena-protocol/src/items.js';

const PAGE = new URL('../../../src/arena-ui/index.html', import.meta.url);
const html = readFileSync(PAGE, 'utf8');
const items = [{ id: 'large-truck', name: 'Large truck', priceSat: 500n }];
const HONEST = 'aa'.repeat(32), LIAR = 'bb'.repeat(32);
const honest = { id: 'h4', name: 'ticktock', devKey: HONEST, nodes: ['http://h1', 'http://h2', 'http://h3'], manifest: { gameName: 'ticktock', gameDevPubkey: new Uint8Array(32).fill(0xaa), version: 4, requiredProtocolVersion: 10, items } };
const liar = { id: 'l5', name: 'ticktock', devKey: LIAR, nodes: ['http://liar'], manifest: { gameName: 'ticktock', gameDevPubkey: new Uint8Array(32).fill(0xbb), version: 5, requiredProtocolVersion: 11, items } };

test('the chosen tile\'s item terms are its own developer\'s version, not a stranger\'s same-name v5', () => {
  const src = html.slice(html.indexOf("    const ITEMS_SHARE_KEY = 'arena.items.devsPct';"), html.indexOf('    async function openShop() {'));
  const kept = new Map();
  const localStorage = { getItem: (k) => (kept.has(k) ? kept.get(k) : null), setItem: (k, v) => kept.set(k, String(v)) };
  const window = { ARENA_BROWSER_STORE: () => localStorage, ARENA_GAME_CHOSEN: honest, ARENA_GAMES_FULL: [honest, liar] };
  pageFunction(PAGE, ['window', 'localStorage', 'ARENACLIENT'], src, '')(window, localStorage, { itemTermsOf, itemShareOn, itemPriceOn, shopOf, ITEM_DEV_SHARES });
  assert.equal(window.ARENA_ITEMS_TERMS().reserves, false, 'the honest v4 (protocol 10) terms, not the liar v5 (protocol 11) reserves terms');
});

test('the donation box of a game names the chosen tile\'s developer key and seats', async () => {
  // from the page's key helpers when it has them (the fix), else from donateSets itself (before it)
  const at = html.indexOf('    const gameDevKeyOf = (gameName) => {');
  const src = html.slice(at >= 0 ? at : html.indexOf('    async function donateSets(gameName) {'), html.indexOf('    async function donateWallets() {'));
  const window = { ARENA_GAME_CHOSEN: honest, ARENA_GAMES_FULL: [honest, liar],
    ARENA_LOBBY_ROWS: [{ id: 'r1', free: false, game: 'h4', contract: { censusHeight: 1 }, said: [{ node: 'http://h1' }] }] };
  const ARENACLIENT = { fromHex: (h) => h, fetchDonationSet: async () => ({ ok: true, target: { game: ['g'], network: ['n'] } }) };
  const run = pageFunction(PAGE, ['window', 'ARENACLIENT', 'pageEd25519Verify', 'paidRoundFromSeats'], src, 'return donateSets;');
  const donateSets = run(window, ARENACLIENT, () => true, async () => null);
  const got = await donateSets('ticktock');
  assert.equal(got.ok, true);
  assert.deepEqual([...got.game.gameDevPubkey], [...honest.manifest.gameDevPubkey], 'the donation game key is the honest developer\'s');
  assert.deepEqual(got.seats, honest.nodes, 'the seats are the honest tile\'s');
});
