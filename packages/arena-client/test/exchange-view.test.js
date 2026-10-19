// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE EXCHANGE VIEW OF A MARKET (2026-10-17: "complete order book bids ask, chart, depth (switchable) like an
// exchange"; "For all prediction markets"): the ladder, the chart's points and the volume, from a seat's GET /book as it serves it
// (BigInts as strings).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exchangeLadder, exchangeHistory, exchangeVolume } from '../src/exchange-view.js';

// Up buys at 40¢ (9,900 msat net -> 24,750 msat of shares) and 38¢; Down buys at 55¢ (an Up ask at 45¢); a sell of Up at 60¢;
// a sell of Down at 70¢ (an Up bid at 30¢)
const BOOK = { ok: true, levels: {
  buys: [{ outcome: 0, price: '40000', netMsat: '9900', expiryMs: '0' }, { outcome: 0, price: '40000', netMsat: '4000', expiryMs: '0' },
    { outcome: 0, price: '38000', netMsat: '19000', expiryMs: '0' }, { outcome: 1, price: '55000', netMsat: '11000', expiryMs: '0' }],
  sells: [{ outcome: 0, price: '60000', sharesMsat: '7000' }, { outcome: 1, price: '70000', sharesMsat: '3000' }] },
  batches: [{ k: 10, price: '52000', fills: [{ id: 'a' }] }, { k: 4, price: '50000', fills: [{ id: 'b' }] }, { k: 12, price: '61000', fills: [] }],
  positions: [{ shares: ['10000', '0'] }, { shares: ['0', '10000'] }] };

test('trading Up: Up buys are bids, Down buys asks at 100 - q, sells on their sides; by the cent, best first', () => {
  const L = exchangeLadder(BOOK, { side: 0 });
  assert.deepEqual(L.bids.map((r) => [r.cents, r.shares]), [[40, 34], [38, 50], [30, 3]]);
  assert.deepEqual(L.asks.map((r) => [r.cents, r.shares]), [[45, 20], [60, 7]]);
  assert.deepEqual([L.bestBid, L.bestAsk, L.spread, L.mid], [40, 45, 5, 42.5]);
  assert.equal(L.bids[1].cumShares, 84);
  assert.equal(L.bids[0].totalSat, Math.round(34 * 40 / 100));
});

test('trading Down mirrors it: the same book, the other side', () => {
  const L = exchangeLadder(BOOK, { side: 1 });
  assert.deepEqual(L.bids.map((r) => [r.cents, r.shares]), [[55, 20], [40, 7]]);
  assert.deepEqual(L.asks.map((r) => [r.cents, r.shares]), [[60, 34], [62, 50], [70, 3]]);
});

test('the chart is each matched batch\'s price, oldest first; the volume is the sets matched; an empty book draws nothing', () => {
  assert.deepEqual(exchangeHistory(BOOK, { side: 0 }), [{ t: 2500, cents: 50 }, { t: 5500, cents: 52 }]);
  assert.deepEqual(exchangeHistory(BOOK, { side: 1 }).map((p) => p.cents), [50, 48]);
  assert.equal(exchangeVolume(BOOK), 10);
  const empty = exchangeLadder({ ok: true, batches: [], resting: { buys: [], sells: [] }, positions: [] });
  assert.deepEqual([empty.asks, empty.bids, empty.mid, empty.spread], [[], [], null, null]);
  assert.deepEqual(exchangeHistory(null), []);
});
