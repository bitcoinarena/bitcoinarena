// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ROUNDS THAT TOOK ORDERS HERE LATELY (2026-10-17: "When I reload the page my open orders are gone and still no
// closed orders"; "Have the open orders from the nodes not from local storage"): GET /market-rounds names them - newest first, at most
// 200, at most 2 days back - so a page reads its player's own orders back from their books, closed rounds too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { OrderBook } from '../src/order-batch.js';

const NOW = 1_792_266_000_000;
const db = new DatabaseSync(':memory:');
db.exec('CREATE TABLE market_orders (order_id TEXT PRIMARY KEY, round_id BLOB NOT NULL, body TEXT NOT NULL, received_ms INTEGER NOT NULL, batch INTEGER)');
const put = db.prepare('INSERT INTO market_orders (order_id, round_id, body, received_ms, batch) VALUES (?, ?, ?, ?, NULL)');
const rid = (n) => new Uint8Array(32).fill(n);
put.run('o1', rid(1), '{}', NOW - 3600000);                     // round 01: an hour ago
put.run('o2', rid(1), '{}', NOW - 60000);                       //           and a minute ago
put.run('o3', rid(2), '{}', NOW - 1800000);                     // round 02: half an hour ago
put.run('o4', rid(3), '{}', NOW - 3 * 24 * 3600000);            // round 03: three days ago
const recent = (since) => OrderBook.prototype.recentRounds.call({ db }, since, NOW);

test('rounds that took orders, newest order first, never further back than 2 days', () => {
  assert.deepEqual(recent(0), [{ round: '01'.repeat(32), lastOrderMs: NOW - 60000 }, { round: '02'.repeat(32), lastOrderMs: NOW - 1800000 }]);
});

test('since cuts the list: only rounds with an order at or after it', () => {
  assert.deepEqual(recent(NOW - 900000).map((r) => r.round.slice(0, 2)), ['01']);
  assert.deepEqual(recent(NOW + 1), []);
});

test('at most 200 rounds', () => {
  for (let i = 0; i < 250; i++) put.run('x' + i, new Uint8Array(32).fill(0).map((_, j) => (j === 0 ? 0xaa : j === 1 ? i : 0)), '{}', NOW - i * 1000);
  assert.equal(recent(0).length, 200);
});
