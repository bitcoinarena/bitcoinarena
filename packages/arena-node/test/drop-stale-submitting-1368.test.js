// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1368 (audit 2 #1204 SETTLEMENT-4): a kept send plan the payouts no longer match is dropped only while no signed settlement may still land
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WinningsSend } from '../src/winnings-send.js';

const E = new Uint8Array(32).fill(1);
const seat = (state) => {
  let dropped = 0;
  const round = { settlementState: () => state, sendAttemptsOf: () => [{ entryId: E, attempt: 0, state: 'PLANNED', payoutMsat: 1000n }],
    dropPlannedSends: () => { dropped++; return 1; } };
  const w = new WinningsSend({ round });
  w.wanting = () => [{ entryId: E, payout: { msat: 900n } }];   // the rebuilt payout differs (a new fee rule, a gone stake)
  return { w, dropped: () => dropped };
};

test('#1368 a SUBMITTING or ACCEPTED settlement keeps its send plan; before it, or once REFUSED, a stale plan drops', () => {
  for (const [state, drops] of [['SUBMITTING', false], ['ACCEPTED', false], [null, true], ['REFUSED', true]]) {
    const s = seat(state);
    assert.equal(s.w.dropIfStale(new Uint8Array(32), {}), drops, `${state}`);
    assert.equal(s.dropped(), drops ? 1 : 0, `${state}: rows deleted`);
  }
});

test('#1368 a plan the payouts still match is never dropped', () => {
  const s = seat(null);
  s.w.wanting = () => [{ entryId: E, payout: { msat: 1000n } }];
  assert.equal(s.w.dropIfStale(new Uint8Array(32), {}), false);
  assert.equal(s.dropped(), 0);
});
