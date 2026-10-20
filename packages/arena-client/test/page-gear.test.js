// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE GEAR FROM THE FIRST PAINT (Settings waited 2.6-5.1 s for Unity's lobby). The page's own code runs
// under the page's name (page-script.js) on a small fake page. Measured: the strip with the gear is up over the loading
// screen, Unity's title and the lobby, and gone over a round's own screens and while driving; the backup warning and the
// balance strip stay over the lobby alone; a click on the gear opens Settings at once, before the page's main script,
// and that script fills the panel once - on its own catch-up if the click came first, on the click otherwise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageFunction } from './page-script.js';

const PAGE = new URL('../../../src/arena-ui/index.html', import.meta.url);
const HTML = readFileSync(PAGE, 'utf8');
const slice = (from, to) => { const a = HTML.indexOf(from); assert.ok(a > 0, `index.html holds ${from.slice(0, 50)}`); return HTML.slice(a, HTML.indexOf(to, a) + to.length); };
const PAINT = slice('    function paintMoney() {', '\n    }\n');
const EARLY = slice("  document.getElementById('arena-settings-go').addEventListener('click', () => {", '\n  });');
const CATCH_UP = slice('    if (window.ARENA_SETTINGS_EARLY && settingsPanel()', '\n');

const LOBBY = { showing: true, lobby: true, screen: [430, 932], balance: [56, 468, 318, 34] };

function strip({ unity = true, boot = false, lobby = LOBBY, driving = false, broughtIn = false }) {
  const els = {};
  const el = (id) => (els[id] = els[id] || { id, textContent: '', style: {} });
  for (const id of ['arena-money', 'arena-settings', 'arena-lobby-balance', 'arena-backup-notice', 'arena-backup-warn', 'arena-settings-backup',
    'arena-lobby-confirmed', 'arena-bal-confirmed', 'arena-lobby-pending', 'arena-bal-pending', 'arena-balance-line', 'arena-money-why']) el(id);
  const canvas = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 430, height: 932 }) };
  // the backup warning sits in the loading screen: it is gone with #boot
  const document = { getElementById: (id) => (id === 'canvas' ? canvas : id === 'boot' ? (boot ? {} : null) : id === 'arena-backup-warn' && !boot ? null : els[id] || null) };
  const window = { BLWP_UNITY_LOBBY: lobby, ARENA_WALLET_BALANCE: null, unityInstance: unity ? {} : undefined };
  const ARENACLIENT = { backupLine: () => 'This wallet has no backup.', NO_BACKUP_LINE: 'This wallet has no backup.' };
  pageFunction(PAGE, ['document', 'window', 'ARENACLIENT', 'drivingNow', 'backupStore', 'walletSeed', 'isBackedUp', 'seedBroughtIn'], PAINT, 'return paintMoney();')(
    document, window, ARENACLIENT, () => driving, () => ({}), () => 'seed', () => false, () => broughtIn);
  return { money: els['arena-money'].style.display, warn: boot ? els['arena-backup-warn'].style.display : 'gone', balance: els['arena-lobby-balance'].style.display };
}

test('the strip with the gear is up from the loading screen on: before Unity, over its title, over the lobby', () => {
  // (2026-10-19: "backup warning should always be in the loading screen instead of the header")
  assert.deepEqual(strip({ unity: false, boot: true, lobby: undefined }), { money: '', warn: 'flex', balance: 'none' }, 'the loading screen: the header and the backup warning');
  assert.deepEqual(strip({ lobby: { showing: true, lobby: false } }), { money: '', warn: 'gone', balance: 'none' }, 'Unity\'s title, no lobby: the header alone');
  assert.deepEqual(strip({}), { money: '', warn: 'gone', balance: 'flex' }, 'the lobby: the header and the balance, no warning in the header');
});

test('over a round\'s own screens and while driving the strip is gone', () => {
  assert.equal(strip({ lobby: { showing: false } }).money, 'none', 'Unity left the lobby (cargo panel, drive)');
  assert.equal(strip({ driving: true }).money, 'none');
});

function page() {
  const listeners = {};
  const panel = { style: { display: 'none' } };
  const document = { getElementById: (id) => (id === 'arena-settings' ? panel
    : id === 'arena-settings-go' ? { addEventListener: (ev, fn) => { listeners[ev] = fn; } } : null) };
  const window = {};
  pageFunction(PAGE, ['document', 'window'], EARLY)(document, window);
  return { click: () => listeners.click(), panel, window };
}

test('a click before the main script: Settings opens at once, and the main script fills it once when it arrives', () => {
  const { click, panel, window } = page();
  click();
  assert.equal(panel.style.display, '', 'open on the click, with no bundle, wallet or Unity');
  let filled = 0;
  window.ARENA_PAINT_SETTINGS = () => { filled++; };
  const catchUp = pageFunction(PAGE, ['window', 'settingsPanel'], CATCH_UP);
  catchUp(window, () => panel);
  catchUp(window, () => panel);
  assert.equal(filled, 1, 'filled once, not on every pass');
});

test('a click after the main script: opened and filled on the click, once', () => {
  const { click, panel, window } = page();
  let filled = 0;
  window.ARENA_PAINT_SETTINGS = () => { filled++; };
  pageFunction(PAGE, ['window', 'settingsPanel'], CATCH_UP)(window, () => panel);
  assert.equal(filled, 0, 'nothing to catch up on: Settings was never opened');
  click();
  assert.equal(panel.style.display, '');
  assert.equal(filled, 1);
});

test('the gear has one click handler: the main script no longer adds its own', () => {
  assert.equal(HTML.split("getElementById('arena-settings-go').addEventListener").length - 1, 1);
});

test('a wallet the player brought in - restored words or a Nostr account - shows no backup warning', () => {
  // read on the loading screen, where the warning is since 
  assert.equal(strip({ boot: true }).warn, 'flex', 'a seed minted here and never checked: the warning');
  assert.equal(strip({ boot: true, broughtIn: true }).warn, 'none', 'restored or opened from Nostr: no warning');
});
