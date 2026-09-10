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
  holdSettlement, settlementAction, holdAfter, invoiceMatchesEntry,
  SETTLE, CANCEL, NOTHING,
  HELD, SETTLED, CANCELLED, EXPIRED,
  SETTLEMENT_THRESHOLD, DELIVERED, FAILED, FORFEIT, VOID,
} from '../src/payout.js';

const b32 = (n) => new Uint8Array(32).fill(n);
// No fee and no donation, so every hold here holds the whole stake and the
// arithmetic below is 23.2's alone. What the fee and the donation do to a
// hold is `inclusive.test.js`.
const entry = (n, outcome, score = 0, stakeMsat = 100000n) =>
  ({ entryId: b32(n), pubkey: b32(n), outcome, score, stakeMsat, feeMsat: 0n, donationMsat: 0n });
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

/**
 * THE THREE FATES OF A HOLD, SIDE BY SIDE.
 *
 * Each was measured on its own; this pins them against each other, because the
 * property is that they are DIFFERENT and each stays what it is when the other
 * two are in the same round.
 *
 *   a winner    CANCEL - their stake never enters the pool
 *   a loser     SETTLE - and only with every condition of 23.2 met
 *   VOID        NOTHING - and nobody has to act for the refund
 */
test('a void hold, a settled one and a cancelled one in one round stay three things', () => {
  const winner = entry(1, DELIVERED, 100);
  const loser = entry(2, FORFEIT);
  const voided = entry(3, VOID);

  const s = holdSettlement({ roundId: b32(9), minScore: 1, entries: [winner, loser, voided] });
  assert.deepEqual(s.actions.map((a) => a.action), [CANCEL, SETTLE, NOTHING]);

  assert.equal(s.poolMsat, 100000n, 'the pool is the loser s stake alone');
  assert.equal(s.refundedMsat, 200000n, 'the winner s and the void stake both stay put');
  assert.equal(s.sharesMsat, 100000n);
  assert.equal(s.poolMsat - s.sharesMsat, 0n, 'the house kept something');
  assert.equal(s.table.table[0].amountMsat, 200000n);
  assert.equal(s.table.table.length, 2, 'the void entry is in the payout table');

  // AND WHAT EACH ONE COSTS TO DO. Only VOID needs nothing at all: a refund
  // that waited on five signatures is one an operator could withhold.
  const asked = (outcome, over = {}) => settlementAction({
    outcome, qualifies: outcome === DELIVERED, state: 'SUSPENDED', shares: 0, signatures: 0, ...over,
  });
  assert.equal(asked(VOID).authorised, true);
  assert.deepEqual(asked(VOID).missing, []);
  assert.equal(asked(DELIVERED).authorised, false);
  assert.equal(asked(FORFEIT).authorised, false);
  assert.equal(asked(FORFEIT).missing.length, 3, 'a settle needs three things it did not have');

  // the same round with the loser voided instead: the winner is paid nothing
  // beyond their own stake, and the pool is empty
  const allSafe = holdSettlement({
    roundId: b32(9), minScore: 1, entries: [winner, { ...loser, outcome: VOID }, voided],
  });
  assert.deepEqual(allSafe.actions.map((a) => a.action), [CANCEL, NOTHING, NOTHING]);
  assert.equal(allSafe.poolMsat, 0n);
  assert.equal(allSafe.refundedMsat, 300000n);
  assert.equal(allSafe.table.table[0].amountMsat, 100000n);
});

/**
 * WHERE EACH HOLD ACTUALLY ENDS, as invoice state rather than as a word.
 *
 * Until now `invoice` and `htlc` appeared four times across the source
 * packages and every one was a comment. The three fates were words on a decision; this is
 * the end each one reaches, and the point is that VOID reaches EXPIRED and not
 * CANCELLED - a cancel is an ACT needing five of seven, and a refund that
 * needed an act is one an operator could withhold by doing nothing.
 */
test('a void hold expires, a forfeited one settles, a winner s is cancelled', () => {
  const winner = entry(1, DELIVERED, 100);
  const loser = entry(2, FORFEIT);
  const voided = entry(3, VOID);

  const s = holdSettlement({ roundId: b32(9), minScore: 1, entries: [winner, loser, voided] });
  const ends = s.actions.map((a) => holdAfter({
    action: a.action,
    authorised: settlementAction({
      outcome: a.entry.outcome,
      qualifies: a.entry.outcome === DELIVERED && a.entry.score >= 1,
      ...ready,
    }).authorised,
  }));

  assert.deepEqual(ends.map((e) => e.state), [CANCELLED, SETTLED, EXPIRED]);
  assert.deepEqual(ends.map((e) => e.hasIt), ['the payer', 'the pool', 'the payer']);
  assert.notEqual(ends[2].state, CANCELLED, 'a VOID refund was made into an act');
  assert.notEqual(ends[2].state, SETTLED, 'a VOID stake was taken');
  assert.match(ends[2].why, /nobody has to act/);

  // and the money says the same thing
  assert.equal(s.poolMsat, 100000n, 'the pool is the forfeited stake alone');
  assert.equal(s.refundedMsat, 200000n);
  assert.equal(s.poolMsat - s.sharesMsat, 0n, 'the house kept something');
  assert.equal(s.table.table.length, 2, 'the void entry is in the payout table');
});

test('a hold nobody acts on expires, whatever was supposed to happen to it', () => {
  for (const action of [SETTLE, CANCEL, NOTHING]) {
    const end = holdAfter({ action, authorised: true, nobodyActs: true });
    assert.equal(end.state, EXPIRED, action);
    assert.equal(end.hasIt, 'the payer');
  }

  // and one that may not be acted on yet is in nobody's balance
  const waiting = holdAfter({ action: SETTLE, authorised: false });
  assert.equal(waiting.state, HELD);
  assert.equal(waiting.hasIt, 'nobody');
  assert.match(waiting.why, /if they never are, it expires back to the payer/);

  // an unauthorised cancel is not a settle by another name
  assert.equal(holdAfter({ action: CANCEL, authorised: false }).state, HELD);
  assert.throws(() => holdAfter({ action: 'RELEASE' }), /not something that can be done to a hold/);
});

/**
 * THE LAST CHECK BEFORE THE MONEY IS IN FLIGHT.
 *
 * 23.1: the endpoint issues a hold invoice for `payment_hash`, the player's
 * wallet pays it, and from that moment the stake is committed. Nothing checked
 * that invoice against the entry the player signed - an invoice for another
 * hash commits the money to a preimage the committee's shares do not
 * reconstruct, so nobody could ever settle it and nobody could prove why.
 */
test('a player pays an invoice only for the hash and amount their entry signed', () => {
  const stakeCommitment = new Uint8Array(32).fill(0xa7);
  // 6e: the hold is for the NET stake - 100000 committed, 2000 of it the fee.
  const entry = { stakeCommitment, stakeMsat: 100000n, feeMsat: 2000n, donationMsat: 0n };

  const good = invoiceMatchesEntry({ paymentHash: stakeCommitment, amountMsat: 98000n, entry });
  assert.equal(good.ok, true, good.why);
  assert.match(good.why, /the ones this entry signed/);

  // another hash: the shares would reconstruct a preimage for a different one
  const elsewhere = invoiceMatchesEntry({
    paymentHash: new Uint8Array(32).fill(0xbb), amountMsat: 98000n, entry,
  });
  assert.equal(elsewhere.ok, false);
  assert.match(elsewhere.why, /nobody could ever settle it/);

  // one byte of the hash
  const nearly = new Uint8Array(stakeCommitment);
  nearly[31] ^= 1;
  assert.equal(invoiceMatchesEntry({ paymentHash: nearly, amountMsat: 98000n, entry }).ok, false);

  // more than the entry holds, and less - THE COMMITMENT ITSELF AMONG THEM:
  // an invoice for the whole 100000 puts the fee in a hold that is cancelled
  // back to a winner, which is the on-top reading 6e removed
  for (const amountMsat of [100000n, 98001n, 97999n, 0n, 1000000n]) {
    const said = invoiceMatchesEntry({ paymentHash: stakeCommitment, amountMsat, entry });
    assert.equal(said.ok, false, String(amountMsat));
    assert.match(said.why, new RegExp(`asks ${amountMsat} msat and this entry holds 98000: `
      + 'a stake of 100000 less a fee of 2000 and a donation of 0'));
  }

  // and the shapes that are not an invoice at all
  assert.equal(invoiceMatchesEntry({ paymentHash: stakeCommitment, amountMsat: 98000n }).ok, false);
  assert.equal(invoiceMatchesEntry({ paymentHash: stakeCommitment, amountMsat: 98000, entry }).ok, false);
  assert.equal(invoiceMatchesEntry({ paymentHash: new Uint8Array(31), amountMsat: 98000n, entry }).ok, false);
  // an entry that names no fee is not read as a free one
  const unnamed = invoiceMatchesEntry({
    paymentHash: stakeCommitment, amountMsat: 100000n, entry: { stakeCommitment, stakeMsat: 100000n },
  });
  assert.equal(unnamed.ok, false, 'an entry with no fee named was held whole');
  assert.match(unnamed.why, /names its stake, its fee and its donation/);
});
