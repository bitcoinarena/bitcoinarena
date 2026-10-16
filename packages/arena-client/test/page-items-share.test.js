// THE IN-GAME ITEMS' DEVELOPERS' SHARE (kanban #377, the owner 2026-10-16 ~06:58Z: "50% of the fees go to protocol devs and game devs (25/25)
// but are fully optional. There is a screen in settings called advanced settings which has two select boxes, the existing donation
// dropdown and a new one for ingame options: 50% 40% 30% 20% 10% 0%. The price shown in the buy screens is this dynamic, if the ingame
// donations are zero the price is 250 Sats instead of 500 sats. Node fees are never optional. It is at the very bottom of the settings
// screen and needs to be scrolled to be visible.") - the page's own markup and helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageFunction } from './page-script.js';
import { itemPriceFor, ITEM_DEV_SHARES } from '../../arena-protocol/src/items.js';

const PAGE = new URL('../../../unity-proto/Assets/WebGLTemplates/NextBlock/index.html', import.meta.url);
const html = readFileSync(PAGE, 'utf8');

test('Advanced settings is the last card of Settings, with the donation dropdown and the in-game share 50 .. 0 %', () => {
  const settings = html.slice(html.indexOf('<div id="blwp-settings"'), html.indexOf('  <script>\n  // SETTINGS OPENS ON THE FIRST CLICK'));
  const cards = [...settings.matchAll(/<section class="settings-card" id="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(cards.at(-1), 'blwp-set-advanced', `the cards: ${cards.join(', ')}`);
  assert.ok(!cards.includes('blwp-set-donation'), 'the donation card moved into Advanced settings');
  const adv = settings.slice(settings.indexOf('id="blwp-set-advanced"'));
  assert.match(adv, /<h3>Advanced settings<\/h3>/);
  assert.match(adv, /<select id="blwp-donation-select"/);
  const share = adv.slice(adv.indexOf('<select id="arena-items-share-select"'), adv.indexOf('</select>', adv.indexOf('arena-items-share-select')));
  assert.deepEqual([...share.matchAll(/<option value="(\d+)"( selected)?>(\d+)%<\/option>/g)].map((m) => [Number(m[1]), !!m[2]]),
    [[50, true], [40, false], [30, false], [20, false], [10, false], [0, false]]);
});

test('the price at the share: 500 sat at the default 50 %, 250 sat at 0 %, kept in this browser; an unknown value is 50 %', () => {
  const src = html.slice(html.indexOf("    const ITEMS_SHARE_KEY = 'arena.items.devsPct';"), html.indexOf('    async function openShop() {'));
  const kept = new Map();
  const localStorage = { getItem: (k) => (kept.has(k) ? kept.get(k) : null), setItem: (k, v) => kept.set(k, String(v)) };
  const window = {};
  pageFunction(PAGE, ['window', 'localStorage', 'BLWPCLIENT'], src, '')(window, localStorage, { itemPriceFor, ITEM_DEV_SHARES });
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
  assert.equal((html.match(/String\(window\.ARENA_ITEM_PRICE\(it\.priceSat\)\)/g) || []).length, 5);
  assert.match(html, /const need = window\.ARENA_ITEM_PRICE\(it\.priceSat\) \* 1000n;/);
  assert.match(html, /priceSat: Number\(window\.ARENA_ITEM_PRICE\(it\.priceSat\)\), listSat: Number\(it\.priceSat\)/);
  assert.match(html, /BLWPCLIENT\.buyItem\(\{ manifest: shop\.game\.manifest, itemId: it\.id, networkSet: ds\.target\.network, gameSet: ds\.target\.game, wallet, federationId, devsPct,/);
  assert.equal((html.match(/String\(it\.priceSat\)/g) || []).length, 0, 'no list price shown as the price anywhere');
});
