// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2780: measured 2026-11-15 on the test host, the seats' price reads timed out together at the wall clock's 5-minute marks (the host's
// CPU taken by other jobs) while the venue answered in 0.2 s, and three seats of a committee missing one moment cost the round that sample. A
// failed read is now asked once more inside the same 5 s period; a stale answer is not asked again, and none is asked past the period's room.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PriceFeed, READ_RETRY_ROOM_MS } from '../src/price-feed.js';
import { PRICE_SAMPLE_EVERY_MS } from '../../arena-protocol/src/price-sample.js';

test('#2780 a failed read is asked once more in its period, and that reading is the moment\'s', async () => {
  let t = Date.UTC(2026, 10, 15, 14, 10, 0) + 300;
  let asks = 0;
  const feed = new PriceFeed({}, { readPrice: async () => { asks++; if (asks === 1) { t += 1200; throw new Error('The operation was aborted due to timeout'); } return { cents: 6_400_000, atMs: t - 200 }; },
    now: () => t, log: () => {} });
  assert.equal(await feed.read(), 6_400_000, 'the moment has no reading after one timed-out read');
  assert.equal(asks, 2);
  assert.equal(feed.ownAt(Date.UTC(2026, 10, 15, 14, 10, 0)), 6_400_000, 'the reading is not the moment\'s');
});

test('#2780 no second ask past the period\'s room, and none for a stale answer', async () => {
  let t = Date.UTC(2026, 10, 15, 14, 10, 0);
  let asks = 0;
  const late = new PriceFeed({}, { readPrice: async () => { asks++; t += PRICE_SAMPLE_EVERY_MS - READ_RETRY_ROOM_MS; throw new Error('timeout'); }, now: () => t, log: () => {} });
  assert.equal(await late.read(), null);
  assert.equal(asks, 1, 'asked again with no room left in the period');
  asks = 0; t = Date.UTC(2026, 10, 15, 14, 20, 0);
  const stale = new PriceFeed({}, { readPrice: async () => { asks++; return { cents: 6_400_000, atMs: t - 20000 }; }, now: () => t, log: () => {} });
  assert.equal(await stale.read(), null);
  assert.equal(asks, 1, 'a stale answer was asked again');
});
