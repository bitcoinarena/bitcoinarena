// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHY MONEY IS ARRIVING, AND WHEN (kanban #617, 2026-10-24: "When is it arriving? Has said this for an hour" - "write it in the Wallet
// screen why is it arriving and WHEN it is arriving with an ETA"): the page's own ARENA_NOTE_ARRIVING / ARENA_ARRIVING_LINE, run as written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageFunction } from './page-script.js';

const PAGE = new URL('../../../src/arena-ui/index.html', import.meta.url);
const HTML = readFileSync(PAGE, 'utf8');
const A = '33'.repeat(32), B = '4d'.repeat(32);

function page(start) {
  const store = new Map();
  const vault = () => ({ getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) });
  const a = HTML.indexOf("      const ARRIVING_KEY = 'arena.arriving';");
  const b = HTML.indexOf("      window.ARENA_ORDER_TIMES = window.ARENA_ORDER_TIMES || new Map();", a);
  const window = {};
  let now = start;
  const DateNow = { now: () => now };
  const FakeDate = class extends Date { static now() { return now; } };
  pageFunction(PAGE, ['window', 'vault', 'Date'], [HTML.slice(a, b)], '')(window, vault, FakeDate);
  return { window, at: (ms) => { now = ms; }, store, DateNow };
}
const T = Date.UTC(2026, 9, 24, 17, 0, 0);

test('a noted reason, before and after its time; money no reason names; a landed issue is dropped', () => {
  const p = page(T);
  p.window.ARENA_NOTE_ARRIVING(A, 'merging in 2,214 sat from your other wallet 8942e2e7', 30000);
  let line = p.window.ARENA_ARRIVING_LINE([{ federation: A, sats: 2275, arriving: 2214 }]);
  assert.equal(line, '2,214 sat arriving: merging in 2,214 sat from your other wallet 8942e2e7 · expected by 17:00 UTC');
  p.at(T + 61 * 60000);
  line = p.window.ARENA_ARRIVING_LINE([{ federation: A, sats: 2275, arriving: 2214 }]);
  assert.match(line, /late: expected by 17:00 UTC, arriving since 1 h 1 min - the federation 33333333 has not issued them yet$/);
  // another federation issuing with no reason noted here: named as such, timed from when it was first seen
  line = p.window.ARENA_ARRIVING_LINE([{ federation: A, sats: 2275, arriving: 0 }, { federation: B, sats: 100, arriving: 50 }]);
  assert.match(line, /^50 sat arriving: notes the federation is still issuing to this wallet .* · expected by 18:02 UTC$/);
  assert.equal(JSON.parse(p.store.get('arena.arriving'))[A.slice(0, 16)], undefined, 'landed: dropped');
  assert.equal(p.window.ARENA_ARRIVING_LINE([{ federation: B, sats: 150, arriving: 0 }]), '');
});
