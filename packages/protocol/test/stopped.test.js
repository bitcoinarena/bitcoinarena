// §15 AT THE ROUND'S CLOSE (ruled 2026-09-12): a transcript that stops becomes a
// deterministic result, never a refund. No receipted first mark by the start
// deadline is FORFEIT; a run LIVE at its last receipted checkpoint is FAILED.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { stoppedOutcome, firstMarkOutcome } from '../src/first-mark.js';
import { FORFEIT, FAILED, VOID, ENTRY_VOID } from '../src/payout.js';

test('a walk-away at the close: no first mark is FORFEIT, a stopped run is FAILED, neither is VOID or ENTRY_VOID', () => {
  const said = (x) => stoppedOutcome(x).outcome;
  assert.equal(said({ receiptedMarks: 0, deadlinePassed: true }), FORFEIT);
  assert.equal(said({ receiptedMarks: 0, liveAtLast: true, deadlinePassed: true }), FORFEIT, 'no mark is no started run');
  assert.equal(said({ receiptedMarks: 0, deadlinePassed: false }), null, 'before the deadline nothing is decided');
  assert.equal(said({ receiptedMarks: 1, liveAtLast: true, deadlinePassed: true }), FAILED);
  assert.equal(said({ receiptedMarks: 7, liveAtLast: true, deadlinePassed: true }), FAILED);
  assert.equal(said({ receiptedMarks: 7, liveAtLast: false, deadlinePassed: true }), null, 'a run that ended is its replay\'s');
  for (const x of [{ receiptedMarks: 0, deadlinePassed: true }, { receiptedMarks: 3, liveAtLast: true, deadlinePassed: true }])
    assert.ok(![VOID, ENTRY_VOID].includes(said(x)), 'a walk-away became a refund');
  assert.match(stoppedOutcome({ receiptedMarks: 0, deadlinePassed: true }).why, /never started.*not a refund/);
  assert.throws(() => stoppedOutcome({ receiptedMarks: -1, deadlinePassed: true }), /whole count/);
  assert.throws(() => stoppedOutcome({ receiptedMarks: 1.5, deadlinePassed: true }), /whole count/);
  // AND THE DOOR STILL DECIDES NOTHING FOR NO MARK: the close does.
  assert.equal(firstMarkOutcome({ joinTick: 0, deadlineTicks: 900, firstMark: null }).outcome, null);
});
