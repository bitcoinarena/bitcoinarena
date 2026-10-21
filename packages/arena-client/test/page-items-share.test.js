// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE IN-GAME ITEMS' DEVELOPERS' SHARE (2026-10-16 ~06:58Z: "50% of the fees go to protocol devs and game devs (25/25)
// but are fully optional. There is a screen in settings called advanced settings which has two select boxes, the existing donation
// dropdown and a new one for ingame options: 50% 40% 30% 20% 10% 0%. The price shown in the buy screens is this dynamic, if the ingame
// donations are zero the price is 250 Sats instead of 500 sats. Node fees are never optional. It is at the very bottom of the settings
// screen and needs to be scrolled to be visible.") - the page's own markup and helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageFunction } from './page-script.js';
import { itemPriceFor, ITEM_DEV_SHARES } from '../../arena-protocol/src/items.js';

const PAGE = new URL('../../../src/arena-ui/index.html', import.meta.url);
const html = readFileSync(PAGE, 'utf8');
// AND UNITY'S ADD-ONS VIEW, which is Tick Tock's page part (kanban #521): every buy screen is in one or the other
const shipped = html + '\n' + readFileSync(new URL('../../nextblock/page/unity-page.js', import.meta.url), 'utf8');

// the owner ~13:40Z: "Advanced settings muss ein eigener Menüpunkt sein ganz unten und dann geht ein neuer Screen auf"
test('Advanced settings is the last menu item of Settings and opens a screen of its own: the donation dropdown and the in-game share 40 .. 0 %', () => {
  const settings = html.slice(html.indexOf('<div id="arena-settings"'), html.indexOf('  <script>\n  // SETTINGS OPENS ON THE FIRST CLICK'));
  const screenAt = settings.indexOf('<div id="arena-settings-advanced"');
  assert.ok(screenAt > 0, 'the Advanced screen');
  const main = settings.slice(0, screenAt), screen = settings.slice(screenAt);
  const cards = [...main.matchAll(/<section class="settings-card[^"]*" id="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(cards.at(-1), 'arena-set-advanced-item', `the menu: ${cards.join(', ')}`);
  assert.match(main.slice(main.indexOf('id="arena-set-advanced-item"')), /<button id="arena-advanced-go" type="button" class="menu-row">Advanced settings/);
  assert.ok(!/<select/.test(main.slice(main.indexOf('id="arena-set-advanced-item"'))), 'no select on the menu item');
  assert.ok(!/arena-donation-select/.test(main), 'the donation dropdown is on the Advanced screen only');
  assert.match(screen, /style="display:none"/);
  assert.match(screen, /<h2 id="arena-advanced-title">ADVANCED SETTINGS<\/h2><button id="arena-advanced-back" type="button">/);
  // the donation and the in-game share are React's cards on the Advanced screen (kanban #564, arena-web SettingsCards)
  for (const id of ['arena-set-advanced', 'arena-set-items-share', 'arena-set-debug-feds']) assert.match(screen, new RegExp(`<section class="settings-card" id="${id}"></section>`));
  const cardsSrc = readFileSync(new URL('../../arena-web/src/arena/SettingsCards.jsx', import.meta.url), 'utf8');
  assert.match(cardsSrc, /<select id="arena-donation-select"/);
  assert.match(cardsSrc, /const \{ share, shares = \[40, 30, 20, 10, 0\], lead, what = '', onChange \} = this\.props;/, 'the reserves\' terms: 40 .. 0 %');
  assert.match(html, /shares: terms \? terms\.shares : \[40, 30, 20, 10, 0\]/, 'the shop\'s terms when known');
  // the menu item opens the screen, Back and Settings' Close hide it
  assert.match(html, /getElementById\('arena-advanced-go'\)\.addEventListener\('click', \(\) => \{\n\s+document\.getElementById\('arena-settings-advanced'\)\.style\.display = '';/);
  assert.match(html, /getElementById\('arena-advanced-back'\)\.addEventListener\('click', \(\) => \{ document\.getElementById\('arena-settings-advanced'\)\.style\.display = 'none'; \}\);/);
  assert.match(html, /getElementById\('arena-settings-close'\)\.addEventListener\('click', \(\) => \{\n\s+document\.getElementById\('arena-settings-advanced'\)\.style\.display = 'none';/);
});

test('the price at the share: 500 sat at the default 50 %, 250 sat at 0 %, kept in this browser; an unknown value is 50 %', () => {
  const src = html.slice(html.indexOf("    const ITEMS_SHARE_KEY = 'arena.items.devsPct';"), html.indexOf('    async function openShop() {'));
  const kept = new Map();
  const localStorage = { getItem: (k) => (kept.has(k) ? kept.get(k) : null), setItem: (k, v) => kept.set(k, String(v)) };
  const window = { ARENA_BROWSER_STORE: () => localStorage };   // the page's one door to the browser's store
  pageFunction(PAGE, ['window', 'localStorage', 'ARENACLIENT'], src, '')(window, localStorage, { itemPriceFor, ITEM_DEV_SHARES });
  assert.equal(window.ARENA_ITEMS_SHARE(), 50);
  assert.equal(window.ARENA_ITEM_PRICE(500), 500n);
  for (const [pct, sat] of [[40, 450n], [30, 400n], [20, 350n], [10, 300n], [0, 250n]]) {
    window.ARENA_ITEMS_SHARE_SET(pct);
    assert.deepEqual([window.ARENA_ITEMS_SHARE(), window.ARENA_ITEM_PRICE(500)], [pct, sat]);
  }
  window.ARENA_ITEMS_SHARE_SET(25);
  assert.equal(window.ARENA_ITEMS_SHARE(), 50, 'a share not offered reads as the default');
});

test('every buy screen prices at the share: the shop sheet, its paying line, the wallet check, Unity\'s add-ons view and its paying line', () => {
  // the shop sheet's rows are React's (kanban #564, ShopItems: its price line and Buy button show price(priceSat), arena-web shop.test.mjs);
  // the page hands it the share's price - and keeps its paying line, the wallet check and Unity's two
  assert.match(shipped, /price: \(priceSat\) => window\.ARENA_ITEM_PRICE\(priceSat\),/);
  assert.equal((shipped.match(/String\(window\.ARENA_ITEM_PRICE\(it\.priceSat\)\)/g) || []).length, 3);
  assert.match(shipped, /const need = window\.ARENA_ITEM_PRICE\(it\.priceSat\) \* 1000n;/);
  assert.match(shipped, /priceSat: Number\(window\.ARENA_ITEM_PRICE\(it\.priceSat\)\), listSat: Number\(it\.priceSat\)/);
  assert.match(shipped, /ARENACLIENT\.buyItem\(\{ manifest: shop\.game\.manifest, itemId: it\.id, networkSet: ds\.target\.network, gameSet: ds\.target\.game, wallet, federationId, devsPct,/);
  assert.equal((shipped.match(/String\(it\.priceSat\)/g) || []).length, 0, 'no list price shown as the price anywhere');
});

// OUTSIDE A SELLING GAME (2026-10-17: "This 50% is wrong if 20% are taken by a ingame item"): Settings opened from the
// games screen or another game takes the terms of the newest version that sells items - the reserves' 40 .. 0 % - not 's 50 %
test('with no game chosen the share and the price are the newest selling version\'s - nodes 40 %, reserves 20 %, 40 .. 0 %', async () => {
  const { itemTermsOf, itemShareOn, itemPriceOn, shopOf } = await import('../src/item-buy.js');
  const src = html.slice(html.indexOf("    const ITEMS_SHARE_KEY = 'arena.items.devsPct';"), html.indexOf('    async function openShop() {'));
  const kept = new Map();
  const localStorage = { getItem: (k) => (kept.has(k) ? kept.get(k) : null), setItem: (k, v) => kept.set(k, String(v)) };
  const items = [{ id: 'large-truck', name: 'Large truck', priceSat: 500n }];
  const window = { ARENA_BROWSER_STORE: () => localStorage, ARENA_GAME_CHOSEN: null, ARENA_GAMES_FULL: [
    { name: 'rock-paper-scissors', manifest: { gameName: 'rock-paper-scissors', version: 3, requiredProtocolVersion: 2, items: [] } },
    { name: 'nextblock', manifest: { gameName: 'nextblock', version: 3, requiredProtocolVersion: 10, items } },
    { name: 'nextblock', manifest: { gameName: 'nextblock', version: 4, requiredProtocolVersion: 11, items } }] };
  pageFunction(PAGE, ['window', 'localStorage', 'ARENACLIENT'], src, '')(window, localStorage, { itemTermsOf, itemShareOn, itemPriceOn, shopOf, ITEM_DEV_SHARES });
  const t = window.ARENA_ITEMS_TERMS();
  assert.deepEqual([t.reserves, t.shares, t.nodesPct, t.reservesPct], [true, [40, 30, 20, 10, 0], 40, 20]);
  assert.equal(window.ARENA_ITEMS_SHARE(), 40, 'the default share on the reserves\' terms');
  assert.equal(window.ARENA_ITEM_PRICE(500), 500n, '200 nodes + 100 reserves + 200 developers');
  window.ARENA_ITEMS_SHARE_SET(0); assert.equal(window.ARENA_ITEM_PRICE(500), 300n, 'at 0 %: the nodes\' 40 % and the reserves\' 20 %');
  window.ARENA_ITEMS_SHARE_SET(50); assert.equal(window.ARENA_ITEMS_SHARE(), 40, 'a kept 50 % (the old terms) is 40 % on these');
});
