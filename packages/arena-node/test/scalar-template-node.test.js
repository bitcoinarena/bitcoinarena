// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A SCALAR TEMPLATE'S ROUND, SETTLED BY A SEAT (2026.0.8, kanban #362): the table the settlement, the stake-share handout and
// GET /outcome all read (game-market.js attestedTable) is paid between THE ROUND'S bounds, never the template's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attestedTable } from '../src/game-market.js';
import { RESULT_TYPE, SCALAR_SIDES } from '../../arena-protocol/src/manifest.js';

const MANIFEST = { gameName: 'price-at', resultType: RESULT_TYPE.ATTESTED, outcomes: [...SCALAR_SIDES], scalar: { low: 0n, high: 100000000n, unit: 'USD cents' },
  template: { category: 'prices', maxOutcomes: 2, resolveWithinMs: 86400000n }, marketTerms: { resolveAfterCloseMs: 60000n } };
const CONTRACT = { entryCloseMs: 1000n, event: { question: 'q', outcomes: ['Higher', 'Lower'], resolveAtMs: 100000n, scalar: { low: 8000000n, high: 9000000n } } };
const ENTRIES = [{ entryId: 'aa'.repeat(32), stakeMsat: 1000n, feeMsat: 0n, donationMsat: 0n, pick: 0 },
  { entryId: 'bb'.repeat(32), stakeMsat: 1000n, feeMsat: 0n, donationMsat: 0n, pick: 1 }];

test('a scalar template round\'s table is split by where the value lies between ITS bounds', () => {
  const t = attestedTable(MANIFEST, ENTRIES, { value: 8500000n }, CONTRACT);
  assert.deepEqual([t.low, t.high, t.rows.map((r) => r.payoutMsat)], [8000000n, 9000000n, [1000n, 1000n]]);
  const top = attestedTable(MANIFEST, ENTRIES, { value: 9500000n }, CONTRACT);
  assert.deepEqual([top.clamped, top.rows.map((r) => r.payoutMsat)], [9000000n, [2000n, 0n]], 'above the round\'s high bound LONG takes the pool');
  // the same value over the TEMPLATE's bounds would split it 8.5 / 91.5 - what a seat reading the manifest alone would have paid
  const wrong = attestedTable(MANIFEST, ENTRIES, { value: 8500000n }, null);
  assert.deepEqual(wrong.rows.map((r) => r.payoutMsat), [170n, 1830n]);
});
