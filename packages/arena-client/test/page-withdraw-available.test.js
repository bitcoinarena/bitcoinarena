// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE LOBBY'S "Withdrawal available" LINE SAYS ONLY WHAT IS IN NO BALANCE CHIP (2026-10-04 13:39:
// "Withdrawal available: 98 sat - press Withdraw in the wallet panel" while those 98 sat were already inside the confirmed
// 506 sat). index.html's withdrawAvailable - what the page hands Unity's DailyLobby.WithdrawNotice - runs under the page's
// name (page-script.js). Measured: the owed amount of the last look (collected into the player wallet by WINNINGS-AUTO, shown
// by the chips) is not counted; ecash a failed Withdraw left in the round's own wallet is, and the panel's warning for it is
// page-lock.js's withdrawLine, unchanged; another tab holding the round is said as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageFunction } from './page-script.js';
import { withdrawLine } from '../src/page-lock.js';

const PAGE = new URL('../../../unity-proto/Assets/WebGLTemplates/NextBlock/index.html', import.meta.url);
const HTML = readFileSync(PAGE, 'utf8');
const at = HTML.indexOf('    function withdrawAvailable() {');
assert.ok(at > 0, 'index.html hands Unity withdrawAvailable');
const SRC = HTML.slice(at, HTML.indexOf('\n    }\n', at) + '\n    }\n'.length);
const available = (window) => pageFunction(PAGE, ['window'], SRC, 'return withdrawAvailable();')(window);

// DailyLobby.WithdrawNotice (DailyLobby.cs:151-157), the lobby's painter of this field, as written
const withdrawNotice = (w) => !w || !w.available ? '' : w.elsewhere ? 'Withdrawal available - open in another tab of this browser'
  : (BigInt(w.msat) > 0n ? `Withdrawal available: ${BigInt(w.msat) / 1000n} sat - press Withdraw in the wallet panel` : '');

test('the owner\'s state: 98,000 msat owed at the last look, already collected into the player wallet, round wallet empty - nothing available, no lobby line', () => {
  const w = available({ ARENA_OWED: { owedMsat: 98000n }, ARENA_WITHDRAWABLE: 0n, ARENA_ELSEWHERE: null });
  assert.deepEqual(w, { available: false, msat: '0', elsewhere: false });
  assert.equal(withdrawNotice(w), '');
});

test('after a failed Withdraw: 98,000 msat in the round\'s own wallet - available, the lobby line, and the panel warning', () => {
  const window = { ARENA_OWED: { owedMsat: 0n }, ARENA_WITHDRAWABLE: 98000n, ARENA_ELSEWHERE: null };
  const w = available(window);
  assert.deepEqual(w, { available: true, msat: '98000', elsewhere: false });
  assert.equal(withdrawNotice(w), 'Withdrawal available: 98 sat - press Withdraw in the wallet panel');
  assert.equal(withdrawLine(undefined, window.ARENA_WITHDRAWABLE),
    '98000 msat is in this tab\'s wallet - withdraw it to your own wallet before you close the tab');
});

test('another tab of this browser holds the round: said as before', () => {
  const w = available({ ARENA_OWED: { owedMsat: 98000n }, ARENA_WITHDRAWABLE: undefined, ARENA_ELSEWHERE: 'e4b6a534' });
  assert.deepEqual(w, { available: true, msat: '0', elsewhere: true });
  assert.equal(withdrawNotice(w), 'Withdrawal available - open in another tab of this browser');
});

test('nothing looked at yet: nothing available', () => {
  assert.deepEqual(available({}), { available: false, msat: '0', elsewhere: false });
});
