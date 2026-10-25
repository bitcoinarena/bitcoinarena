// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// NO "WAITING FOR THE RESULT" FLASH AT PAGE LOAD (2026-10-20 23:13 local, phone, UI 269: "At page load it shows waiting for
// result, then it disappears. Nothing is paid out" - his two orders of 20:45-21:00, settled and paid two hours before, were listed
// under My orders as "waiting for the result" until the page's first outcome read moved them to History): an order whose window
// closed before the page loaded is kept out of sight until its round's outcome was asked once; one that closes while the page is
// open shows "waiting" as it truly is; the market page asks the outcomes at load, not 10 s later.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { quietOrders } from '../src/market.js';

const H = 3600000;
const NOW = 1792530800000;
const LOADED = NOW - 2000;
const pick = (entry, round, closeMs, order = {}) => ({ entryIdHex: entry, roundIdHex: round, entryCloseMs: String(closeMs), order: { placedMs: closeMs - 600000, ...order } });
const waiting = (entry) => ({ entry, state: 'waiting' });

test('kept out of sight: closed before the load and not read yet; shown once read, or when it closed while the page was open', () => {
  const old = pick('e1', 'r1', NOW - 2 * H);              // the 20:45-21:00 orders, read two hours later
  const justClosed = pick('e2', 'r2', NOW - 1000);        // closed after the page loaded
  const open = pick('e3', 'r3', NOW + 60000);             // still open
  const lines = [waiting('e1'), waiting('e2'), { entry: 'e3', state: 'open' }];
  const picks = [old, justClosed, open];
  assert.deepEqual([...quietOrders({ picks, lines, read: new Set(), loadedMs: LOADED, nowMs: NOW })], ['e1']);
  // its round read once: it shows as it stands - in History when final, "waiting" only if its result truly is not there
  assert.deepEqual([...quietOrders({ picks, lines, read: new Set(['r1']), loadedMs: LOADED, nowMs: NOW })], []);
  // a line with a result is never hidden
  assert.deepEqual([...quietOrders({ picks, lines: [{ entry: 'e1', state: 'won' }], read: new Set(), loadedMs: LOADED, nowMs: NOW })], []);
});

test('as before: an order read back from the seats, closed over 10 min ago, for its first minute', () => {
  const restored = pick('e4', 'r4', NOW - H, { restored: true, placedMs: NOW - 30000 });
  const lines = [waiting('e4')];
  assert.deepEqual([...quietOrders({ picks: [restored], lines, read: new Set(['r4']), loadedMs: NOW - 2 * H, nowMs: NOW })], ['e4']);
  assert.deepEqual([...quietOrders({ picks: [restored], lines, read: new Set(['r4']), loadedMs: NOW - 2 * H, nowMs: NOW + 60000 })], []);
});

test('the market page reads the outcomes at load and hides by quietOrders', () => {
  const page = readFileSync(new URL('../../btc-updown/page/market-page.js', import.meta.url), 'utf8');
  assert.match(page, /setTimeout\(\(\) => \{ readMarketOutcomes\(\)[^\n]*\}, 300\)/);
  assert.match(page, /ARENACLIENT\.quietOrders\(\{ picks, lines: all, read: OUTCOMES_READ, loadedMs: PAGE_LOADED_MS/);
});
