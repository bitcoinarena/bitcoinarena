// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2931 (feedback #243): two fee sets accepted for one activation height were decided by array order - feesAt answered whichever the
// caller held last. Now the higher proposal id wins a tie, the order the seats fold in (funding-book.js feeFold).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feesAt, FEES_TODAY } from '../src/fee-proposal.js';

const A = { proposal: 'aa'.repeat(32), activationHeight: 500, fees: { ...FEES_TODAY, roundNodeBps: 300 } };
const B = { proposal: 'bb'.repeat(32), activationHeight: 500, fees: { ...FEES_TODAY, roundNodeBps: 500 } };

test('#2931 a tie at one height gives one set whatever the order held', () => {
  assert.deepEqual(feesAt({ height: 600, accepted: [A, B] }), B.fees);
  assert.deepEqual(feesAt({ height: 600, accepted: [B, A] }), B.fees);
});

test('#2931 heights still decide first, and nothing before activation', () => {
  const C = { proposal: '00'.repeat(32), activationHeight: 550, fees: { ...FEES_TODAY, roundNodeBps: 700 } };
  assert.deepEqual(feesAt({ height: 600, accepted: [C, B, A] }), C.fees);
  assert.deepEqual(feesAt({ height: 499, accepted: [A, B] }), FEES_TODAY);
});
