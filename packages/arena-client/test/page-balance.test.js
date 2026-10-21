// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE LOBBY'S BALANCE AND PENDING LINE, AS THE PAGE PAINTS THEM (index.html's paintMoney was never run by a
// test). The page's own function runs under the page's name (page-script.js) on a small fake page. Measured: the
// confirmed and pending sats in the lobby and in Settings - a dash, not a number, until the wallet reports - the balance
// strip laid over Unity's own balance row, scaled from Unity's layout to the canvas, and the strip gone while driving.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageFunction } from './page-script.js';
import { ArenaText, ArenaBits } from './arena-text.js';   // the page's React lines (kanban #564)

const PAGE = new URL('../../../src/arena-ui/index.html', import.meta.url);
const HTML = readFileSync(PAGE, 'utf8');
const at = HTML.indexOf('    function paintMoney() {');
const SRC = HTML.slice(at, HTML.indexOf('\n    }\n', at) + '\n    }\n'.length);
assert.ok(at > 0, 'index.html paints its money in paintMoney');

function paint({ balance, lobby = { showing: true, lobby: true, screen: [430, 932], balance: [56, 468, 318, 34] }, driving = false, canvas = { left: 0, top: 0, width: 430, height: 932 } }) {
  const els = {};
  const el = (id) => (els[id] = els[id] || { id, textContent: '', style: {} });
  for (const id of ['arena-money', 'arena-settings', 'arena-lobby-balance', 'arena-backup-notice', 'arena-backup-warn', 'arena-settings-backup',
    'arena-lobby-confirmed', 'arena-bal-confirmed', 'arena-lobby-pending', 'arena-bal-pending', 'arena-balance-line', 'arena-money-why']) el(id);
  const document = { getElementById: (id) => (id === 'canvas' ? { getBoundingClientRect: () => canvas } : id === 'boot' ? null : els[id] || null) };
  const window = { ArenaText, ArenaBits, ARENA_UNITY_LOBBY: lobby, ARENA_WALLET_BALANCE: balance, unityInstance: {} };
  const ARENACLIENT = { backupLine: () => 'This wallet has no backup.', NO_BACKUP_LINE: 'This wallet has no backup.' };
  pageFunction(PAGE, ['document', 'window', 'ARENACLIENT', 'drivingNow', 'backupStore', 'walletSeed', 'isBackedUp', 'seedBroughtIn'], SRC, 'return paintMoney();')(
    document, window, ARENACLIENT, () => driving, () => ({}), () => 'seed', () => false, () => false);
  return els;
}

test('a reported balance: confirmed and pending in sats, in the lobby and in Settings, and no "no balance" line', () => {
  const els = paint({ balance: { sats: 1234, pending: 98 } });
  for (const id of ['arena-lobby-confirmed', 'arena-bal-confirmed']) assert.equal(els[id].textContent, '1,234 sat');
  for (const id of ['arena-lobby-pending', 'arena-bal-pending']) assert.equal(els[id].textContent, '98 sat');
  assert.equal(els['arena-balance-line'].textContent, '');
});

test('no balance reported yet: a dash for both, never an invented number, and the line says so', () => {
  const els = paint({ balance: null });
  for (const id of ['arena-lobby-confirmed', 'arena-lobby-pending', 'arena-bal-confirmed', 'arena-bal-pending']) assert.equal(els[id].textContent, '–');
  assert.equal(els['arena-balance-line'].textContent, 'No balance in this wallet yet');
});

test('the balance strip lies on Unity\'s own balance row, scaled from Unity\'s layout to the canvas', () => {
  const same = paint({ balance: { sats: 0, pending: 0 } })['arena-lobby-balance'].style;
  assert.deepEqual([same.display, same.left, same.top, same.width, same.height], ['flex', '56px', '468px', '318px', '34px']);
  const half = paint({ balance: { sats: 0, pending: 0 }, canvas: { left: 10, top: 20, width: 215, height: 466 } })['arena-lobby-balance'].style;
  assert.deepEqual([half.left, half.top, half.width, half.height], ['38px', '254px', '159px', '17px']);
});

test('while driving the lobby strip is gone; off the lobby the balance strip is hidden', () => {
  const driving = paint({ balance: { sats: 5, pending: 0 }, driving: true });
  assert.equal(driving['arena-money'].style.display, 'none');
  const off = paint({ balance: { sats: 5, pending: 0 }, lobby: { showing: false, lobby: true, screen: [430, 932], balance: [56, 468, 318, 34] } });
  assert.equal(off['arena-money'].style.display, 'none');
  assert.equal(off['arena-lobby-balance'].style.display, 'none');
});
