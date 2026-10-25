// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ROUND OF THE MONEY'S FEDERATION FIRST (kanban #614, 2026-10-24 playtest: an Up/Down order took federation 4dc88be7's round while the
// money was in 337ae01a, and asked to swap): the page's own moneyFirst (index.html) hands a game client the rows of one window with the round
// of the federation that holds the most SPENDABLE sats first - a part still merging names its federation by 16 hex, and is not spendable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageFunction } from './page-script.js';

const PAGE = new URL('../../../src/arena-ui/index.html', import.meta.url);
const HTML = readFileSync(PAGE, 'utf8');
const A = '33'.repeat(32), B = '4d'.repeat(32);
const row = (id, fed) => ({ id, contract: { federationId: Uint8Array.from(Buffer.from(fed, 'hex')) } });
const toHex = (u) => Buffer.from(u).toString('hex');

function moneyFirstWith(balance, deposit = null) {
  const a = HTML.indexOf('    function moneyFirst(rows) {');
  const body = HTML.slice(a, HTML.indexOf('\n    }\n', a) + 7);
  const window = { ARENA_WALLET_BALANCE: balance, ARENA_DEPOSIT_FEDERATION: deposit };
  const out = {};
  pageFunction(PAGE, ['window', 'ARENACLIENT', 'out'], [body], 'out.moneyFirst = moneyFirst;')(window, { toHex }, out);
  return out.moneyFirst;
}

test('the round of the federation holding the spendable sats is first, not one whose sats are still merging (kanban #614)', () => {
  const rows = [row('b-round', B), row('a-round', A)];
  // the playtest's shape: 100 sat spendable in A, 300 still merging into B under its 16-hex name
  const mf = moneyFirstWith({ parts: [{ federation: A, sats: 100, arriving: 0, merging: 0 }, { federation: B.slice(0, 16), sats: 300, arriving: 0, merging: 300 }] });
  assert.deepEqual(mf(rows).map((r) => r.id), ['a-round', 'b-round']);
});

test('a federation named by its first 16 hex still puts its round first', () => {
  const mf = moneyFirstWith({ parts: [{ federation: B.slice(0, 16), sats: 500, arriving: 0, merging: 0 }] });
  assert.deepEqual(mf([row('a-round', A), row('b-round', B)]).map((r) => r.id), ['b-round', 'a-round']);
});

test('no spendable money: the deposit federation first; nothing known: the lobby\'s order', () => {
  assert.deepEqual(moneyFirstWith({ parts: [] }, { federation: B })([row('a-round', A), row('b-round', B)]).map((r) => r.id), ['b-round', 'a-round']);
  assert.deepEqual(moneyFirstWith(null, null)([row('a-round', A), row('b-round', B)]).map((r) => r.id), ['a-round', 'b-round']);
});
