// FIVE OF SEVEN PUT THE STAKE PREIMAGE BACK; FOUR PUT NOTHING BACK.
//
// 23.1: "The player splits P with verifiable secret sharing (Shamir, threshold
// 5-of-7)... Verifiability means each node can confirm its share is consistent
// without reconstructing P." 23.4: "Settling a loser's HTLC requires
// reconstructing P, which requires 5 of the 7 shares."
//
// So the property that matters is what FOUR colluding settlement nodes hold,
// and it is measured here rather than asserted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';

import {
  splitSecret, reconstruct, openStake, shareIsConsistent, shareCommitment,
  FIELD, SHARES_NEEDED, SHARES_TOTAL,
} from '../src/shares.js';
import { toHex } from '../src/hash.js';

const preimage = new Uint8Array(randomBytes(32));
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());

/** The randomness is the caller's; a test needs the same split twice. */
const coefficients = [1n, 2n, 3n, 4n].map((n) => n * 0x1234567890abcdefn + 7n);
const split = () => splitSecret(preimage, { coefficients });

const everyChoice = (list, k) => {
  const out = [];
  const walk = (from, taken) => {
    if (taken.length === k) { out.push(taken.slice()); return; }
    for (let i = from; i < list.length; i++) { taken.push(list[i]); walk(i + 1, taken); taken.pop(); }
  };
  walk(0, []);
  return out;
};

test('the field is a prime a thirty-two byte secret fits inside with room', () => {
  assert.equal(FIELD, (1n << 521n) - 1n);
  assert.ok(FIELD > (1n << 256n), 'a 32-byte secret would not fit');
  assert.equal(SHARES_NEEDED, 5);
  assert.equal(SHARES_TOTAL, 7);
});

test('one share per seat, and each seat can check its own without rebuilding P', () => {
  const { shares } = split();
  assert.equal(shares.length, 7);
  assert.deepEqual(shares.map((s) => s.seat), [1, 2, 3, 4, 5, 6, 7]);

  for (const s of shares) {
    assert.equal(shareIsConsistent(s, s.commitment), true);
    assert.ok(s.value > 0n && s.value < FIELD);
  }

  // a share altered in transit does not match what was published for its seat
  const [first] = shares;
  assert.equal(shareIsConsistent({ ...first, value: first.value + 1n }, first.commitment), false);

  // nor does another seat's share, handed over under this seat's name
  assert.equal(shareIsConsistent({ seat: first.seat, value: shares[1].value }, first.commitment), false);

  // AND A SHARE IS ONE SEAT'S. Seat 1's own value, presented as seat 2's, does
  // not match seat 2's commitment - otherwise one member could hand over
  // another's share as their own and be counted twice towards the five.
  assert.equal(shareIsConsistent({ seat: shares[1].seat, value: first.value },
    shares[1].commitment), false, 'a share was accepted under another seat s name');
  assert.equal(shareIsConsistent({ seat: shares[1].seat, value: first.value },
    first.commitment), false);

  // and the commitment says nothing about P: it is the share's, not the secret's
  assert.notEqual(toHex(first.commitment), toHex(shareCommitment(first.seat, first.value + 1n)));
});

/**
 * FOUR SHARES RECONSTRUCT NOTHING - refused, rather than answered. Four points
 * interpolate a perfectly good polynomial of their own; it simply does not
 * name P, and a function that handed that back would hand back a wrong
 * preimage that looks exactly like a right one.
 */
test('any four of the seven reconstruct nothing at all', () => {
  const { shares } = split();
  const fours = everyChoice(shares, 4);
  assert.equal(fours.length, 35, 'there are thirty-five ways to pick four of seven');

  for (const four of fours) {
    assert.throws(() => reconstruct(four),
      /4 shares cannot reconstruct anything: 5 are needed/,
      four.map((s) => s.seat).join(','));
  }

  // and if somebody interpolates them anyway, the answer is not P - measured
  // by asking for a four-of-four reconstruction of the same points
  for (const four of fours.slice(0, 5)) {
    const wrong = reconstruct(four, { needed: 4 });
    assert.notEqual(toHex(wrong), toHex(preimage),
      `four shares named P at seats ${four.map((s) => s.seat).join(',')}`);
  }

  // three and one and none are refused the same way
  for (const n of [0, 1, 2, 3]) {
    assert.throws(() => reconstruct(shares.slice(0, n)), /cannot reconstruct anything/);
  }
});

/**
 * AND EVERY FIVE PUT BACK EXACTLY P, whichever five. Not a sample: all
 * twenty-one, because a threshold that worked for some sets and not others
 * would be a settlement that depended on which nodes answered.
 */
test('every five of the seven reconstruct exactly P, and its hash is the commitment', () => {
  const { shares } = split();
  const fives = everyChoice(shares, 5);
  assert.equal(fives.length, 21, 'there are twenty-one ways to pick five of seven');

  const stakeCommitment = sha256(preimage);
  for (const five of fives) {
    const back = reconstruct(five);
    assert.deepEqual(back, preimage, `seats ${five.map((s) => s.seat).join(',')}`);
    assert.deepEqual(sha256(back), stakeCommitment,
      'the reconstructed preimage does not hash to what the player signed');
  }

  // six and seven do too
  assert.deepEqual(reconstruct(shares.slice(0, 6)), preimage);
  assert.deepEqual(reconstruct(shares), preimage);
});

test('a split is refused rather than guessed when it is not one', () => {
  assert.throws(() => splitSecret(new Uint8Array(31), { coefficients }), /32 bytes/);
  assert.throws(() => splitSecret(preimage, { coefficients: [] }), /needs 4 coefficients/);
  assert.throws(() => splitSecret(preimage, { coefficients, needed: 1 }), /below two is not a threshold/);
  assert.throws(() => splitSecret(preimage, { coefficients, seats: 3 }), /3 seats cannot carry/);

  // one seat answering twice is one share, not two
  const { shares } = split();
  assert.throws(() => reconstruct([shares[0], shares[0], shares[1], shares[2], shares[3]]),
    /two shares for one seat are one share/);
});

/**
 * A DIFFERENT SECRET GIVES DIFFERENT SHARES, and the same secret with
 * different randomness does too - so a share reveals nothing about which
 * preimage it belongs to by looking like one from another round.
 */
test('shares differ with the secret and with the randomness', () => {
  const other = new Uint8Array(randomBytes(32));
  const a = split();
  const b = splitSecret(other, { coefficients });
  const c = splitSecret(preimage, { coefficients: coefficients.map((x) => x + 1n) });

  assert.notEqual(a.shares[0].value, b.shares[0].value);
  assert.notEqual(a.shares[0].value, c.shares[0].value);
  assert.deepEqual(reconstruct(b.shares.slice(0, 5)), other);
  assert.deepEqual(reconstruct(c.shares.slice(0, 5)), preimage);
});

/**
 * WHAT A DISHONEST DEALER CAN STILL DO, MEASURED RATHER THAN GUESSED.
 *
 * The contract of this piece is SHARE-TO-SEAT BINDING, not polynomial binding.
 * A dealer who splits with two polynomials and gives some seats the second one
 * hands out shares that EACH pass their own seat commitment, and nothing here
 * catches it at handout. It is caught at reconstruction, and this counts what
 * that costs.
 *
 * The player is the dealer, and the stake is theirs to lose - so a dealer who
 * mis-shares is a player arranging that a loss can never be settled.
 */
test('a two-polynomial dealer: how many of the twenty-one five-subsets open P', () => {
  const other = new Uint8Array(randomBytes(32));
  const honest = split().shares;
  const second = splitSecret(other, { coefficients: coefficients.map((x) => x + 99n) }).shares;
  const stakeCommitment = sha256(preimage);

  // k seats are given the second polynomial's share instead of their own
  const counts = [];
  for (let k = 0; k <= 3; k++) {
    const mixed = honest.map((s, i) => (i >= 7 - k ? second[i] : s));

    // EVERY ONE OF THEM STILL PASSES ITS OWN SEAT. That is the whole point:
    // nothing at handout can tell.
    for (let i = 0; i < mixed.length; i++) {
      const published = i >= 7 - k ? second[i].commitment : honest[i].commitment;
      assert.equal(shareIsConsistent(mixed[i], published), true, `seat ${i + 1} at k=${k}`);
    }

    const seen = openStake(mixed, { stakeCommitment });
    assert.equal(seen.subsets, 21);
    counts.push([k, seen.opens, seen.refused, seen.ok]);
  }

  assert.deepEqual(counts, [
    [0, 21, 0, true],     // honest: every five opens it
    [1, 6, 15, true],     // one bad share: the six subsets avoiding it still open it
    [2, 1, 20, true],     // two: exactly one subset is left
    [3, 0, 21, false],    // THREE: no five can open the committed preimage at all
  ]);

  // and the answer names it rather than handing back a wrong preimage
  const worst = openStake(honest.map((s, i) => (i >= 4 ? second[i] : s)), { stakeCommitment });
  assert.equal(worst.ok, false);
  assert.equal(worst.preimage, null);
  assert.match(worst.why, /none of the 21 ways to pick 5 shares opens the committed preimage/);
});

/**
 * AND THE QUIETER HALF IS CLOSED. Without the commitment, two of those
 * twenty-one subsets hand back a well-formed 32-byte value that is not P - a
 * wrong preimage that looks exactly like a right one. With it, they refuse.
 */
test('a subset that rebuilds something is not mistaken for one that rebuilt P', () => {
  const other = new Uint8Array(randomBytes(32));
  const honest = split().shares;
  const second = splitSecret(other, { coefficients: coefficients.map((x) => x + 99n) }).shares;
  const mixed = honest.map((s, i) => (i >= 4 ? second[i] : s));
  const stakeCommitment = sha256(preimage);

  let wrongAccepted = 0;
  let refusedForSize = 0;
  let refusedForCommitment = 0;
  for (const five of everyChoice(mixed, 5)) {
    let unchecked = null;
    try { unchecked = reconstruct(five); } catch { refusedForSize++; }
    if (unchecked && toHex(unchecked) !== toHex(preimage)) wrongAccepted++;
    try { reconstruct(five, { stakeCommitment }); }
    catch (e) {
      if (/not the committed preimage/.test(e.message)) refusedForCommitment++;
    }
  }
  // HOW MANY LAND INSIDE 32 BYTES IS LUCK, not a property: a mixed
  // interpolation lands somewhere in a 521-bit field, and the count moved
  // between runs when it was asserted directly. What does not move is that
  // the ones which DO land there are wrong, and that with the commitment
  // checked every single subset is refused.
  assert.ok(wrongAccepted > 0, 'no subset produced a wrong preimage to catch');
  assert.equal(wrongAccepted, 21 - refusedForSize,
    'a subset produced 32 bytes that were actually P');
  assert.equal(refusedForCommitment, wrongAccepted,
    'the commitment check missed one the unchecked path let through');
  assert.equal(refusedForSize + refusedForCommitment, 21, 'a subset got through');

  // an honest set still opens, and its answer hashes to the commitment
  assert.deepEqual(reconstruct(honest.slice(0, 5), { stakeCommitment }), preimage);
});
