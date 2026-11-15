// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2780: on 11-14 every seat's price read failed together for hours - no reading of its own, none heard, no sample for any round - and
// the log said nothing, so the stop could not be explained afterwards. A moment without a reading is now logged with its reason (a failed read,
// a stale last trade and its age), at most once a minute, with the count of moments since the last line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PriceFeed } from '../src/price-feed.js';
import { PRICE_SAMPLE_EVERY_MS } from '../../arena-protocol/src/price-sample.js';

test('kanban #2780: a moment without a reading is logged with why - a failed read, or the last trade too old - once a minute', async () => {
  let t = Date.UTC(2026, 10, 14, 16, 0, 0);
  const lines = [];
  let answer = () => { throw new Error('the ticker answered 429'); };
  const feed = new PriceFeed({}, { readPrice: async () => answer(), now: () => t, log: (l) => lines.push(l) });
  assert.equal(await feed.read(), null);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /\[prices\] no reading at 2026-11-14T16:00:00.000Z: the read failed: the ticker answered 429 \(1 moment\(s\) without one since the last line\)/);
  // a stale last trade, 20 s old, every 5 s for a minute: one line more, at the minute, counting the moments
  answer = () => ({ cents: 6_400_000, atMs: t - 20000 });
  for (let i = 1; i <= 12; i++) { t += PRICE_SAMPLE_EVERY_MS; assert.equal(await feed.read(), null); }
  assert.equal(lines.length, 2, lines.join('\n'));
  assert.match(lines[1], /the last trade was 20 s old \(a reading is at most 5 s old, interim C\) \(12 moment\(s\) without one since the last line\)/);
  // a good read logs nothing
  t += PRICE_SAMPLE_EVERY_MS; answer = () => ({ cents: 6_400_000, atMs: t - 500 });
  assert.equal(await feed.read(), 6_400_000);
  assert.equal(lines.length, 2);
});
