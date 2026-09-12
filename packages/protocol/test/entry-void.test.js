// ENTRY_VOID (§16, THE OUTAGE REFUND) AS A PREDICATE, before any seat wiring.
//
// An on-time first mark that, when the start deadline passed, had fewer than
// the threshold's receipts - every seat it was short of offered it and not
// taking it in time - is ENTRY_VOID. Everything else is not: no mark (§15), a
// late first mark (FORFEIT), a deadline not yet passed, a run that started, a
// seat that answered and refused, a seat never offered, a run past PROVISIONAL.
//
// The measured case (tools/outage-before.mjs): 2 of 2, seat B down at the
// start, A holding the first mark with 1 receipt and its forward unanswered.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { outageOutcome } from '../src/entry-void.js';
import { ENTRY_VOID } from '../src/payout.js';

const base = { firstMark: true, lateStart: false, deadlinePassed: true, receipts: 1, needed: 2, offers: ['unanswered'], state: null };
const said = (change = {}) => outageOutcome({ ...base, ...change }).outcome;

test('the measured outage: an on-time first mark with 1 of 2 receipts, the other seat offered it and silent, is ENTRY_VOID', () => {
  const facts = {
    atA: said(),
    atBWhichTookItLate: said({ offers: ['late'] }),
    noMark: said({ firstMark: false }),
    lateStart: said({ lateStart: true }),
    deadlineNotPassed: said({ deadlinePassed: false }),
    started2of2: said({ receipts: 2, offers: ['receipted'] }),
    otherSeatRefused: said({ offers: ['refused'] }),
    neverOffered: said({ offers: [] }),
    final: said({ state: 'FINAL' }),
    provisionallyFinal: said({ state: 'PROVISIONALLY_FINAL' }),
  };
  console.log('  FACTS (ENTRY_VOID predicates):', JSON.stringify(facts));
  assert.deepEqual(facts, { atA: ENTRY_VOID, atBWhichTookItLate: ENTRY_VOID, noMark: null, lateStart: null,
    deadlineNotPassed: null, started2of2: null, otherSeatRefused: null, neverOffered: null, final: null, provisionallyFinal: null });
  assert.match(outageOutcome({ ...base, lateStart: true }).why, /late start is FORFEIT, not ENTRY_VOID/);
  assert.match(outageOutcome({ ...base, firstMark: false }).why, /§15/);
});

test('5 of 7: short of the threshold only when enough of the missing seats were offered and silent', () => {
  const seven = { ...base, needed: 5 };
  assert.equal(outageOutcome({ ...seven, receipts: 4, offers: ['receipted', 'receipted', 'receipted', 'unanswered', 'unanswered', 'late'] }).outcome, ENTRY_VOID);
  assert.equal(outageOutcome({ ...seven, receipts: 3, offers: ['receipted', 'receipted', 'unanswered', 'unanswered', 'late', 'late'] }).outcome, ENTRY_VOID);
  assert.equal(outageOutcome({ ...seven, receipts: 3, offers: ['receipted', 'receipted', 'unanswered'] }).outcome, null, 'two missing, one offered');
  assert.equal(outageOutcome({ ...seven, receipts: 5, offers: ['receipted', 'receipted', 'receipted', 'receipted', 'unanswered', 'unanswered'] }).outcome, null);
  assert.throws(() => outageOutcome({ ...base, offers: ['maybe'] }), /answered/);
  assert.throws(() => outageOutcome({ ...base, needed: 0 }), /positive count/);
});
