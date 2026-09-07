// WHAT HAPPENS TO A HELD STAKE, SECTION 13C.
//
// "the entry becomes VOID, the stake is refunded by letting the HTLC expire,
// and the entry is excluded from the pool and from the payout table."
//
// The exclusion was already true and measured. What happens to the MONEY was
// written nowhere: there was no settle, no cancel and no refund anywhere in
// packages/*/src, and a stake nobody decides about is a stake the operator is
// holding. A technical failure that let the house keep the stake is exactly
// the shape this protocol exists to make impossible.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  holdSettlement, computePayoutTable, SETTLE, CANCEL,
  DELIVERED, FAILED, FORFEIT, VOID,
} from '../src/payout.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const entry = (n, outcome, score = 0, stakeMsat = 100000n) =>
  ({ entryId: b32(n), pubkey: b32(n), outcome, score, stakeMsat });

test('a VOID stake goes back to the payer and the operator takes nothing', () => {
  const winner = entry(1, DELIVERED, 100);
  const forker = entry(2, FORFEIT);
  const voided = entry(3, VOID);

  const s = holdSettlement({ roundId: b32(9), minScore: 1, entries: [winner, forker, voided] });

  const said = new Map(s.actions.map((a) => [a.entry, a.action]));
  assert.equal(said.get(voided), CANCEL, 'a VOID stake was settled to the operator');
  assert.match(s.actions.find((a) => a.entry === voided).why, /the stake goes back/);

  assert.equal(s.refundedMsat, 100000n, 'the void stake was not refunded');
  assert.equal(s.settledMsat, 200000n, 'the void stake was taken');
  assert.equal(s.paidMsat, 200000n);
  assert.equal(s.settledMsat, s.paidMsat, 'the operator kept the difference');

  // and the void entry is in no row of the table
  assert.equal(s.table.table.length, 2);
  assert.equal(s.table.pool, 100000n);
  assert.equal(s.table.table[0].amountMsat, 200000n);
});

/**
 * THE OTHER DIRECTION, and it is the one that pays for the first: a forfeited
 * stake is SPENT. Refunding it would hand a player who signed two chains their
 * money back and leave the winner with nothing to be paid from.
 */
test('a FORFEIT stake is spent, not refunded', () => {
  const winner = entry(1, DELIVERED, 100);
  const forker = entry(2, FORFEIT);

  const s = holdSettlement({ roundId: b32(9), minScore: 1, entries: [winner, forker] });
  const said = new Map(s.actions.map((a) => [a.entry, a.action]));

  assert.equal(said.get(forker), SETTLE, 'the forfeited stake was refunded');
  assert.equal(s.refundedMsat, 0n);
  assert.equal(s.settledMsat, 200000n);
  assert.equal(s.table.table[0].amountMsat, 200000n,
    'the winner is not paid from the forfeited stake');

  // FAILED is spent the same way: it is the ordinary way to lose
  const failed = holdSettlement({
    roundId: b32(9), minScore: 1, entries: [winner, entry(4, FAILED)],
  });
  assert.equal(failed.refundedMsat, 0n);
  assert.equal(failed.settledMsat, 200000n);
});

/**
 * EVERY ENTRY GETS EXACTLY ONE ANSWER, and the two sides balance. If a VOID
 * hold were ever settled the operator would be holding money the table never
 * hands back, and that is the equality this refuses on.
 */
test('what may be taken equals what is handed back, or it will not answer', () => {
  const entries = [entry(1, DELIVERED, 100), entry(2, FORFEIT), entry(3, VOID), entry(4, VOID)];
  const s = holdSettlement({ roundId: b32(9), minScore: 1, entries });

  assert.equal(s.actions.length, entries.length);
  assert.equal(s.settledMsat + s.refundedMsat, 400000n, 'a stake went missing');
  assert.equal(s.refundedMsat, 200000n);
  assert.equal(s.settledMsat, s.paidMsat);

  // a round where everyone voided: nothing is taken, everything goes back
  const allVoid = holdSettlement({
    roundId: b32(9), minScore: 1, entries: [entry(1, VOID), entry(2, VOID)],
  });
  assert.equal(allVoid.settledMsat, 0n);
  assert.equal(allVoid.refundedMsat, 200000n);
  assert.deepEqual(allVoid.actions.map((a) => a.action), [CANCEL, CANCEL]);
  assert.equal(allVoid.table.table.length, 0);
});

/**
 * AND A ROUND NOBODY WON STILL REFUNDS. Two players, both VOID after a
 * committee that could not agree: the operator takes nothing at all, which is
 * the case an operator would most like to be paid for.
 */
test('a round the committee could not settle pays the operator nothing', () => {
  const s = holdSettlement({
    roundId: b32(9), minScore: 1, entries: [entry(1, VOID), entry(2, VOID), entry(3, VOID)],
  });
  assert.equal(s.settledMsat, 0n);
  assert.equal(s.paidMsat, 0n);
  assert.equal(s.refundedMsat, 300000n);
  assert.ok(s.actions.every((a) => a.action === CANCEL));
});

/**
 * THE CAUTIOUS PLAYER, AND WHY THE BALANCE IS CHECKED RATHER THAN ASSUMED.
 *
 * `computePayoutTable` says of qualification: "a cautious player keeps their
 * stake and simply does not place. Disqualifying them would move their stake
 * into the pool, which is a levy on a legal strategy rather than balance." The
 * table gives that player an amount of ZERO - and their hold is not VOID, so
 * it settles. Zero paid and a settled stake is the operator keeping it.
 *
 * The table's own invariant does not catch it, because with no loser the pool
 * is empty and that check is skipped. This one does: what may be taken must
 * equal what is handed back, and here it does not.
 *
 * Found by probing the table rather than by reading it. It is a hole in the
 * payout model, not in the refund - and this refuses to answer instead of
 * quietly handing the operator a stake.
 */
test('a delivered player below the score, with no losers, is refused rather than skimmed', () => {
  const bold = entry(1, DELIVERED, 100);
  const cautious = entry(2, DELIVERED, 10);

  assert.throws(
    () => holdSettlement({ roundId: b32(9), minScore: 50, entries: [bold, cautious] }),
    /the operator would keep 100000 msat: settled 200000 against 100000 paid out/);

  // with a loser in the round the pool is not empty, the table's own invariant
  // applies, and it is that one which refuses
  assert.throws(
    () => holdSettlement({ roundId: b32(9), minScore: 50, entries: [bold, cautious, entry(3, FAILED)] }),
    /payout invariant broken/);

  // and above the score both are qualifiers, so it balances and answers
  const ok = holdSettlement({ roundId: b32(9), minScore: 5, entries: [bold, cautious] });
  assert.equal(ok.settledMsat, ok.paidMsat);
  assert.equal(ok.refundedMsat, 0n);
});
