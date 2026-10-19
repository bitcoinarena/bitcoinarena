// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// BUY ADD-ONS INSIDE UNITY (2026-10-16): the page hands Unity its add-ons (ARENA_ADDONS_VIEW), buys through the
// shop's own purchase (ARENA_ADDONS_BUY -> buyShopItem), and says from which round a purchase plays: an entry already made keeps what
// it named. The countdown box beside "exit game" offers "Buy add-ons", which opens Unity's panel. The jslib carries all of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const PAGE = readFileSync(new URL('../../../unity-proto/Assets/WebGLTemplates/NextBlock/index.html', import.meta.url), 'utf8');
const JSLIB = readFileSync(new URL('../../../unity-proto/Assets/Plugins/WebGL/blwp.jslib', import.meta.url), 'utf8');
const lineOf = (head) => { const at = PAGE.indexOf(head); assert.ok(at > 0, `the page has no ${head.trim()}`); return PAGE.slice(at, PAGE.indexOf('\n', at)); };

test('from which round a purchase plays: the round being joined, its entry made, is passed over; else the next entry', () => {
  const window = {}; new Function('window', lineOf('    window.ARENA_ADDONS_FROM = '))(window);
  const from = window.ARENA_ADDONS_FROM;
  assert.equal(from({ state: 'joining', round: 'aa' }, 'aa'), 'after-next', 'the next round already entered (held to its start)');
  assert.equal(from({ state: 'joining', round: 'bb' }, 'aa'), 'next', 'its entry not made yet: the purchase is in it');
  assert.equal(from({ state: 'joined', round: 'aa' }, 'aa'), 'next', 'the run going: the next entry');
  assert.equal(from(null, undefined), 'next', 'in the lobby');
  assert.match(PAGE, /window\.BLWP_ENTRY_ROUND = named\.roundIdHex;/, 'the page notes whose entry it made');
});

test('Unity is handed the view, a purchase, "Play with it" and a fresh read; a purchase is the shop sheet\'s own', () => {
  for (const f of ['ARENA_ADDONS_OPEN', 'ARENA_ADDONS_VIEW', 'ARENA_ADDONS_BUY', 'ARENA_ADDONS_USE']) assert.match(PAGE, new RegExp(`window\\.${f} = `), f);
  const buy = PAGE.slice(PAGE.indexOf('    window.ARENA_ADDONS_BUY = '), PAGE.indexOf('    window.ARENA_ADDONS_USE = '));
  assert.match(buy, /await buyShopItem\(shop, it\)/, 'the same purchase as the shop sheet');
  assert.match(buy, /addons\.seq \+= 1; addons\.bought = \{ seq: addons\.seq, id: it\.id, name: it\.name, txid: String\(got\.txid \|\| ''\), from \}/);
  assert.match(buy, /if \(!it \|\| addons\.busy\) return 0;/, 'one purchase at a time');
  for (const f of ['BlwpAddonsState', 'BlwpAddonsBuy', 'BlwpAddonsUse', 'BlwpAddonsOpen']) assert.match(JSLIB, new RegExp(`  ${f}: function \\(`), f);
  assert.match(JSLIB, /window\.ARENA_ADDONS_BUY\(UTF8ToString\(idPtr\)\)/);
});

test('the countdown box offers Buy add-ons beside exit game, shown when the game sells something, opening Unity\'s panel', () => {
  // the donate button sits between add-ons and exit game
  // never one letter a line (2026-10-18, 390 px: three buttons left the words 0 px): the box wraps, the words keep 10em, a phone gives them a row
  assert.match(PAGE, /#blwp-next \{ flex-wrap: wrap; justify-content: center; \} #blwp-next-say \{ min-width: min\(10em, 100%\); \}/);
  assert.match(PAGE, /@media \(max-width: 520px\) \{ #blwp-next \{ width: calc\(100% - 32px\); font-size: 15px; \} #blwp-next-say \{ flex-basis: 100%; text-align: center; \} \}/);
  assert.match(PAGE, /<div id="blwp-next" role="status"><span id="blwp-next-say"><\/span><button id="blwp-next-addons" type="button" style="display:none">Buy add-ons<\/button>(<button id="blwp-next-donate" type="button">[^<]*<\/button>)?<button id="blwp-next-exit"/);
  assert.match(PAGE, /ad\.style\.display = window\.ARENA_ADDONS_VIEW && window\.ARENA_ADDONS_VIEW\(\)\.shop && window\.unityInstance \? '' : 'none';/);
  assert.match(PAGE, /getElementById\('blwp-next-addons'\)\.addEventListener\('click', \(\) => \{\n\s+try \{ window\.unityInstance\.SendMessage\('Bootstrap', 'OpenAddons'\);/);
});
