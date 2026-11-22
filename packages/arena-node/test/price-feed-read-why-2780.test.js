// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2780: on 11-14 every seat's price read failed together for hours - no reading of its own, none heard, no sample for any round - and
// the log said nothing, so the stop could not be explained afterwards. A moment without a reading is now logged with its reason (a failed read,
// a stale last trade and its age), at most once a minute, with the count of moments since the last line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PriceFeed, exchangeTickerCents, coinbaseReading } from '../src/price-feed.js';
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
  assert.match(lines[1], /the last trade was 20 s old and the answer carried no bid and ask to read the mid of \(a trade is at most 5 s old\) \(12 moment\(s\) without one since the last line\)/);
  // a good read logs nothing
  t += PRICE_SAMPLE_EVERY_MS; answer = () => ({ cents: 6_400_000, atMs: t - 500 });
  assert.equal(await feed.read(), 6_400_000);
  assert.equal(lines.length, 2);
});

test('kanban #2780, ruling #2781 (b): a stale last trade reads the bid/ask mid of the same answer; no reading only without a fresh answer', async () => {
  let t = Date.UTC(2026, 10, 15, 9, 0, 0);
  const lines = [];
  let answer;
  const feed = new PriceFeed({}, { readPrice: async () => answer(), now: () => t, log: (l) => lines.push(l) });
  // the last trade 1 s old: the trade
  answer = () => ({ cents: 6_400_000, atMs: t - 1000, answerMs: t - 400, bid: 6_399_990, ask: 6_400_010 });
  assert.equal(await feed.read(), 6_400_000);
  assert.equal(feed.readings.get(t).src, 'trade');
  // a quiet market: the last trade 30 s old, the answer fresh - the mid of its best bid and ask
  t += 5000; answer = () => ({ cents: 6_390_000, atMs: t - 30000, answerMs: t - 600, bid: 6_400_101, ask: 6_400_120 });
  assert.equal(await feed.read(), 6_400_111);
  assert.equal(feed.readings.get(t).src, 'mid');
  // the venue's answer 8 s behind this seat's clock (a frozen venue, or the clock off): no reading, and why
  t += 5000; answer = () => ({ cents: 6_400_000, atMs: t - 8000, answerMs: t - 8000, bid: 6_399_990, ask: 6_400_010 });
  assert.equal(await feed.read(), null);
  assert.match(lines.at(-1), /the venue's answer is 8 s behind this seat's clock \(a fresh answer is at most 5 s behind\)/);
  // the request fails: no reading
  t += 5000; answer = () => { throw new Error('the ticker answered 503'); };
  assert.equal(await feed.read(), null);
});

test('kanban #2780, ruling #2781: the ticker reader carries the answer time and the bid and ask, and no longer falls back to the spot price', async () => {
  const at = 'Sun, 15 Nov 2026 09:00:00 GMT';
  const ok = async () => new Response(JSON.stringify({ price: '64000.01', time: '2026-11-15T08:59:59.500Z', bid: '64000.00', ask: '64000.02' }), { headers: { date: at } });
  assert.deepEqual(await exchangeTickerCents(ok), { cents: 6_400_001, atMs: Date.parse('2026-11-15T08:59:59.500Z'), answerMs: Date.parse(at), bid: 6_400_000, ask: 6_400_002 });
  let asked = [];
  const down = async (u) => { asked.push(u); return new Response('busy', { status: 503 }); };
  await assert.rejects(coinbaseReading(down), /the ticker answered 503/);
  assert.equal(asked.length, 1, 'the spot price is not asked in its place');
});
