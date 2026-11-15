// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2783 (feedback #082): GET /rounds took any `next` and any `ahead` - next=10000 or ahead=8760h held a seat over 30 s, every kept
// row signed and its committees asked. `next` is at most 64 a series and `ahead` at most 120 h.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listingBounds, LISTING_NEXT_MAX, LISTING_AHEAD_MAX_MS } from '../src/server.js';

const of = (q) => listingBounds(new URLSearchParams(q), 8);

test('#2783 next and ahead are bounded; what our own callers ask is unchanged', () => {
  assert.equal(LISTING_NEXT_MAX, 64); assert.equal(LISTING_AHEAD_MAX_MS, 120n * 3600000n);
  // the report's asks
  assert.equal(of('next=10000').perSeries, 64);
  assert.equal(of('next=99999999999999999999').perSeries, 64);
  assert.equal(of('ahead=8760h').aheadMs, 120n * 3600000n);
  assert.equal(of('ahead=99999999999999999999').aheadMs, null, 'a number past 18 digits is malformed: not given');
  assert.equal(of('ahead=8760h').perSeries, null, 'ahead alone: the full listing within the bounded window, as before');
  assert.equal(of('all=1').perSeries, null, 'all=1: the full listing, as before (built once a window, shared)');
  // ours: the page (next=8, next=2, ahead=900000), the bots (next=60), the attestors (ahead=50h), a bare listing (8)
  assert.deepEqual(of('next=8'), { aheadMs: null, perSeries: 8 });
  assert.equal(of('next=60').perSeries, 60);
  assert.equal(of('ahead=900000').aheadMs, 900000n);
  assert.equal(of('ahead=50h').aheadMs, 50n * 3600000n);
  assert.equal(of('next=1&ahead=50h').perSeries, 1);
  assert.deepEqual(of(''), { aheadMs: null, perSeries: 8 });
  assert.equal(of('ahead=soon').aheadMs, null, 'malformed: not given (it threw before)');
});
