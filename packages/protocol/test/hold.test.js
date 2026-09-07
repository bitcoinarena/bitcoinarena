// WHAT HAPPENS TO A HELD STAKE, SECTIONS 13C AND 23.2.
//
// 13C: "the entry becomes VOID, the stake is refunded by letting the HTLC
// expire, and the entry is excluded from the pool and from the payout table."
//
// 23.2 says which of three things each outcome does, and the shape of that
// table is the safety property:
//
//   DELIVERED (qualifying)  Cancel -> the stake returns to the player
//   FAILED / FORFEIT        Settle -> the stake enters the pool wallet
//   VOID                    Do nothing; the HTLC expires and the wallet is
//                           refunded automatically
//
// "The default path - nobody acting - is always the refund. That is what makes
// infrastructure failure safe."
//
// MEASURED BEFORE THIS FILE WAS REWRITTEN: this module answered SETTLE for a
// delivered player and CANCEL for a VOID one. Both are wrong. A winner's stake
// never moves - it comes back by cancelling their own invoice - and a cancel
// REQUIRES five of seven settlement signatures, so calling a VOID refund a
// cancel makes it something an operator can withhold by doing nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  holdSettlement, settlementAction, SETTLE, CANCEL, NOTHING,
  SETTLEMENT_THRESHOLD, DELIVERED, FAILED, FORFEIT, VOID,
} from '../src/payout.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const entry = (n, outcome, score = 0, stakeMsat = 100000n) =>
  ({ entryId: b32(n), pubkey: b32(n), outcome, score, stakeMsat });
const ready = { state: 'FINAL', shares: 5, signatures: 5 };

test('a VOID stake needs nobody to act: the HTLC expires and the wallet is refunded', () => {
  const said = settlementAction({ outcome: VOID, state: 'SUSPENDED', shares: 0, signatures: 0 });
  assert.equal(said.action, NOTHING);
  assert.equal(said.authorised, true, 'a refund was made to wait for somebody');
  assert.deepEqual(said.missing, []);
  assert.match(said.why, /expires and the wallet is refunded automatically/);
  assert.notEqual(said.action, CANCEL, 'a cancel needs five of seven; a refund must not');
});

/**
 * THE ONLY DIRECTION THAT TAKES MONEY FROM A PLAYER, and the only one with
 * five conditions on it. Each missing one is named rather than the whole thing
 * simply failing.
 */
test('a loser s stake is settled only when every condition of 23.2 is met', () => {
  const full = settlementAction({ outcome: FORFEIT, ...ready });
  assert.equal(full.action, SETTLE);
  assert.equal(full.authorised, true);
  assert.match(full.why, /enters the pool wallet/);

  for (const [over, named] of [
    [{ state: 'PROVISIONALLY_FINAL' }, /the result is PROVISIONALLY_FINAL/],
    [{ state: 'SUSPENDED' }, /the result is SUSPENDED/],
    [{ state: undefined }, /the result is not final/],
    [{ shares: 4 }, /4 of 5 preimage shares/],
    [{ signatures: 4 }, /4 of 5 settlement signatures/],
  ]) {
    const said = settlementAction({ outcome: FAILED, ...ready, ...over });
    assert.equal(said.action, SETTLE);
    assert.equal(said.authorised, false, JSON.stringify(over));
    assert.match(said.missing.join('; '), named);
    assert.match(said.why, /stays where it is until every condition is met/);
  }

  // nothing at all: three reasons, not one
  const nothing = settlementAction({ outcome: FORFEIT });
  assert.equal(nothing.authorised, false);
  assert.equal(nothing.missing.length, 3);
  assert.equal(SETTLEMENT_THRESHOLD, 5);
});

test('a delivered player s stake is cancelled back, never settled', () => {
  const won = settlementAction({ outcome: DELIVERED, qualifies: true, ...ready });
  assert.equal(won.action, CANCEL);
  assert.notEqual(won.action, SETTLE, 'a winner s stake was moved into the pool');
  assert.match(won.why, /can only return money to its owner/);

  const cautious = settlementAction({ outcome: DELIVERED, qualifies: false, ...ready });
  assert.equal(cautious.action, CANCEL);
  assert.match(cautious.why, /the stake was never at risk/);

  // and a cancel does need the settlement committee's signatures
  const unsigned = settlementAction({ outcome: DELIVERED, qualifies: true, ...ready, signatures: 4 });
  assert.equal(unsigned.authorised, false);
  assert.match(unsigned.missing.join(''), /4 of 5 settlement signatures/);
});

/**
 * AND THE POOL IS EXACTLY THE LOSERS' STAKES. A qualifier's own stake never
 * enters it, so what the pool hands out is the winnings and nothing else.
 */
test('the pool is the settled stakes, and it hands out exactly what it holds', () => {
  const winner = entry(1, DELIVERED, 100);
  const forker = entry(2, FORFEIT);
  const voided = entry(3, VOID);

  const s = holdSettlement({ roundId: b32(9), minScore: 1, entries: [winner, forker, voided] });
  const said = new Map(s.actions.map((a) => [a.entry, a.action]));

  assert.equal(said.get(voided), NOTHING, 'a VOID refund was made to need an action');
  assert.equal(said.get(winner), CANCEL, 'the winner s own stake was moved');
  assert.equal(said.get(forker), SETTLE);

  assert.equal(s.poolMsat, 100000n, 'the pool is the forfeited stake and nothing else');
  assert.equal(s.refundedMsat, 200000n, 'the winner s stake and the void one both stay put');
  assert.equal(s.sharesMsat, 100000n, 'the pool handed out something other than itself');
  assert.equal(s.poolMsat, s.sharesMsat);

  // the table still says what each player ends with: own stake plus winnings
  assert.equal(s.table.table.length, 2, 'the void entry is in the payout table');
  assert.equal(s.table.table[0].amountMsat, 200000n);
});

test('with no loser there is no pool, and every stake stays with its owner', () => {
  const bold = entry(1, DELIVERED, 100);
  const cautious = entry(2, DELIVERED, 10);

  const s = holdSettlement({ roundId: b32(9), minScore: 50, entries: [bold, cautious] });
  assert.deepEqual(s.actions.map((a) => a.action), [CANCEL, CANCEL]);
  assert.equal(s.poolMsat, 0n);
  assert.equal(s.refundedMsat, 200000n);
  assert.equal(s.sharesMsat, 0n);

  // with a loser, the pool is that loser's stake and the winner takes it
  const withLoser = holdSettlement({
    roundId: b32(9), minScore: 50, entries: [bold, cautious, entry(3, FAILED)],
  });
  assert.equal(withLoser.poolMsat, 100000n);
  assert.equal(withLoser.refundedMsat, 200000n);
  assert.equal(withLoser.sharesMsat, 100000n);
  assert.equal(withLoser.table.table[0].amountMsat, 200000n);
});

test('everyone VOID: nothing is settled, nobody acts, and every stake goes home', () => {
  const s = holdSettlement({
    roundId: b32(9), minScore: 1, entries: [entry(1, VOID), entry(2, VOID), entry(3, VOID)],
  });
  assert.ok(s.actions.every((a) => a.action === NOTHING));
  assert.equal(s.poolMsat, 0n);
  assert.equal(s.sharesMsat, 0n);
  assert.equal(s.refundedMsat, 300000n);
  assert.equal(s.table.table.length, 0);
});

/**
 * A ROUND NOBODY FINISHED. The pool holds every stake and there is no
 * qualifier to hand it to; the table answers without complaint because its own
 * invariant needs one. Refusing is not a decision about what such a round
 * should do - it is declining to make that decision in the operator's favour.
 */
test('a round nobody finished is refused rather than handed to the operator', () => {
  assert.throws(
    () => holdSettlement({ roundId: b32(9), minScore: 1, entries: [entry(1, FAILED), entry(2, FAILED)] }),
    /the operator would keep 200000 msat: a pool of 200000 against 0 handed out/);

  const ok = holdSettlement({
    roundId: b32(9), minScore: 1,
    entries: [entry(1, FAILED), entry(2, FAILED), entry(3, DELIVERED, 100)],
  });
  assert.equal(ok.poolMsat, 200000n);
  assert.equal(ok.sharesMsat, 200000n);
  assert.equal(ok.table.table[2].amountMsat, 300000n, 'the finisher takes the pot and their stake');
});
