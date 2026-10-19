// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
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
  splitSecret, reconstruct, openStake, handoutOutcome, shareIsConsistent,
  shareCommitment, shareOpensTo, checkHandout, FIELD, SHARES_NEEDED, SHARES_TOTAL,
} from '../src/shares.js';
import {
  DELIVERED, FORFEIT, VOID,
} from '../src/payout.js';
import { lockActions, CLAIM, RETURN } from '../src/lock-action.js';
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

test('the field is the order of the group the commitments live in', () => {
  // NOT A FREE CHOICE ANY MORE. Feldman publishes g^a per coefficient, so the
  // exponents are scalars of that group - and the group is secp256k1, the one
  // this system already trusts for bonds and BIP-340, rather than a second one
  // to audit. It used to be 2^521 - 1, which no group here has.
  assert.equal(FIELD,
    0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n);
  assert.notEqual(FIELD, (1n << 521n) - 1n, 'still the old Mersenne field');
  assert.ok(FIELD < (1n << 256n), 'the order is below 2^256, which is why a preimage can be too big');
  assert.equal(SHARES_NEEDED, 5);
  assert.equal(SHARES_TOTAL, 7);
});

test('a preimage at or above the order is refused, never reduced', () => {
  // The room a 32-byte secret used to have is gone: about one preimage in
  // 2^128 is not a scalar. Reducing it would change the number whose hash the
  // player already put in the Entry Contract, so the shares would open a
  // preimage the payment hash does not name - which is why this refuses.
  const tooBig = new Uint8Array(32).fill(0xff);
  assert.ok(BigInt('0x' + toHex(tooBig)) > FIELD);
  assert.throws(() => splitSecret(tooBig, { coefficients }),
    /not below the group order/);

  // and the largest one that IS a scalar still splits
  const largest = new Uint8Array(32);
  let n = FIELD - 1n;
  for (let i = 31; i >= 0; i--) { largest[i] = Number(n & 255n); n >>= 8n; }
  const out = splitSecret(largest, { coefficients });
  assert.equal(out.shares.length, 7);
  assert.deepEqual(reconstruct(out.shares.slice(0, 5)), largest);
});

test('one share per signer node, and each signer node can check its own without rebuilding P', () => {
  const { shares } = split();
  assert.equal(shares.length, 7);
  assert.deepEqual(shares.map((s) => s.signerNode), [1, 2, 3, 4, 5, 6, 7]);

  for (const s of shares) {
    assert.equal(shareIsConsistent(s, s.commitment), true);
    assert.ok(s.value > 0n && s.value < FIELD);
  }

  // a share altered in transit does not match what was published for its signer node
  const [first] = shares;
  assert.equal(shareIsConsistent({ ...first, value: first.value + 1n }, first.commitment), false);

  // nor does another signer node's share, handed over under this signer node's name
  assert.equal(shareIsConsistent({ signerNode: first.signerNode, value: shares[1].value }, first.commitment), false);

  // AND A SHARE IS ONE SIGNER NODE'S. Signer node 1's own value, presented as signer node 2's, does
  // not match signer node 2's commitment - otherwise one member could hand over
  // another's share as their own and be counted twice towards the five.
  assert.equal(shareIsConsistent({ signerNode: shares[1].signerNode, value: first.value },
    shares[1].commitment), false, 'a share was accepted under another signer node s name');
  assert.equal(shareIsConsistent({ signerNode: shares[1].signerNode, value: first.value },
    first.commitment), false);

  // and the commitment says nothing about P: it is the share's, not the secret's
  assert.notEqual(toHex(first.commitment), toHex(shareCommitment(first.signerNode, first.value + 1n)));
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
      four.map((s) => s.signerNode).join(','));
  }

  // and if somebody interpolates them anyway, the answer is not P - measured
  // by asking for a four-of-four reconstruction of the same points
  for (const four of fours.slice(0, 5)) {
    const wrong = reconstruct(four, { needed: 4 });
    assert.notEqual(toHex(wrong), toHex(preimage),
      `four shares named P at signer nodes ${four.map((s) => s.signerNode).join(',')}`);
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
    assert.deepEqual(back, preimage, `signer nodes ${five.map((s) => s.signerNode).join(',')}`);
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
  assert.throws(() => splitSecret(preimage, { coefficients, signerNodes: 3 }), /3 signer nodes cannot carry/);

  // one signer node answering twice is one share, not two
  const { shares } = split();
  assert.throws(() => reconstruct([shares[0], shares[0], shares[1], shares[2], shares[3]]),
    /two shares for one signer node are one share/);
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
 * The contract of this piece is SHARE-TO-SIGNER NODE BINDING, not polynomial binding.
 * A dealer who splits with two polynomials and gives some signer nodes the second one
 * hands out shares that EACH pass their own signer node commitment, and nothing here
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

  // k signer nodes are given the second polynomial's share instead of their own
  const counts = [];
  for (let k = 0; k <= 3; k++) {
    const mixed = honest.map((s, i) => (i >= 7 - k ? second[i] : s));

    // EVERY ONE OF THEM STILL PASSES ITS OWN SIGNER NODE. That is the whole point:
    // nothing at handout can tell.
    for (let i = 0; i < mixed.length; i++) {
      const published = i >= 7 - k ? second[i].commitment : honest[i].commitment;
      assert.equal(shareIsConsistent(mixed[i], published), true, `signer node ${i + 1} at k=${k}`);
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
  // AND THE FIELD CHANGE MADE THIS WORSE, WHICH IS WORTH SAYING. In the old
  // 2^521 - 1 field a mixed interpolation almost never landed inside 32 bytes,
  // so most subsets were refused for their SIZE and only a couple came back as
  // a plausible wrong preimage. The order of secp256k1 is below 2^256, so
  // every element fits in 32 bytes and every one of these subsets now hands
  // back something well-formed. The size accident is gone; the commitment
  // check is what catches them, and it catches all of them.
  console.log(`  mixed subsets: ${wrongAccepted} well-formed and wrong, `
    + `${refusedForSize} too big to be a preimage, ${refusedForCommitment} caught by the commitment`);
  assert.ok(wrongAccepted > 0, 'no subset produced a wrong preimage to catch');
  assert.equal(wrongAccepted, 21 - refusedForSize,
    'a subset produced 32 bytes that were actually P');
  assert.equal(refusedForCommitment, wrongAccepted,
    'the commitment check missed one the unchecked path let through');
  assert.equal(refusedForSize + refusedForCommitment, 21, 'a subset got through');

  // an honest set still opens, and its answer hashes to the commitment
  assert.deepEqual(reconstruct(honest.slice(0, 5), { stakeCommitment }), preimage);
});

/**
 * A HANDOUT NOBODY CAN OPEN IS FORFEIT, NOT VOID.
 *
 * VOID is the operator-fault path: nobody acts, the HTLC expires, the stake
 * goes home. A player who deals three of their own seven signer nodes from a second
 * polynomial has broken settlement of their own stake, and calling that VOID
 * would hand a loser their money back for having done it - the same family as
 * escaping by disconnect.
 */
test('a handout no five signer nodes can open forfeits, and does not refund the dealer', () => {
  const other = new Uint8Array(randomBytes(32));
  const honest = split().shares;
  const second = splitSecret(other, { coefficients: coefficients.map((x) => x + 99n) }).shares;
  const stakeCommitment = sha256(preimage);

  const sabotaged = openStake(honest.map((s, i) => (i >= 4 ? second[i] : s)), { stakeCommitment });
  assert.equal(sabotaged.ok, false);
  assert.equal(sabotaged.opens, 0, 'the k=3 handout opened after all');

  const said = handoutOutcome(sabotaged);
  assert.equal(said.outcome, FORFEIT);
  assert.notEqual(said.outcome, VOID, 'a sabotaged handout was treated as an operator fault');
  assert.match(said.why, /the player dealt them/);
  assert.match(said.why, /not the operator's fault/);

  // an honest handout is nothing to do with this rule
  const fine = handoutOutcome(openStake(honest, { stakeCommitment }));
  assert.equal(fine.outcome, null);
  assert.match(fine.why, /the preimage opened/);

  assert.throws(() => handoutOutcome(undefined), /not an answer from openStake/);
  assert.throws(() => handoutOutcome({ ok: 'no' }), /not an answer from openStake/);
});

/**
 * AND THE MONEY FOLLOWS. The dealer does not get their stake back, the house
 * does not pocket it, and a winner's stake still never enters the pool.
 */
test('the saboteur s stake pays the winner, and the operator takes none of it', () => {
  const b = (n) => new Uint8Array(32).fill(n);
  const winner = { entryId: b(1), pubkey: b(1), outcome: DELIVERED, score: 100, stakeMsat: 100000n, feeMsat: 0n, donationMsat: 0n };
  const saboteur = { entryId: b(2), pubkey: b(2), outcome: FORFEIT, score: 0, stakeMsat: 100000n, feeMsat: 0n, donationMsat: 0n };

  const s = lockActions({ roundId: b(9), minScore: 1, entries: [winner, saboteur] });
  const said = new Map(s.actions.map((a) => [a.entry, a.action]));

  assert.equal(said.get(saboteur), CLAIM, 'the saboteur s stake was handed back');
  assert.equal(said.get(winner), RETURN, 'the winner s stake entered the pool');
  assert.equal(s.poolMsat, 100000n);
  assert.equal(s.refundedMsat, 100000n, 'only the winner s own stake goes home');
  assert.equal(s.sharesMsat, 100000n);
  assert.equal(s.poolMsat - s.sharesMsat, 0n, 'the house kept the difference');
  assert.equal(s.table.table[0].amountMsat, 200000n, 'the winner is paid from the forfeited stake');

  // and had it been VOID, the dealer would have had it back and the winner
  // nothing - which is the escape this classification closes
  const asVoid = lockActions({
    roundId: b(9), minScore: 1, entries: [winner, { ...saboteur, outcome: VOID }],
  });
  assert.equal(asVoid.poolMsat, 0n);
  assert.equal(asVoid.refundedMsat, 200000n);
  assert.equal(asVoid.table.table[0].amountMsat, 100000n, 'only the stake back');
});

/**
 * FELDMAN, AS THE RULE IT IS - the security of it is measured elsewhere.
 *
 * The group here is Z_n under addition, written as a point-shaped 33 bytes.
 * It is a real group and the algebra of the check is identical, which is what
 * this file is for: `packages/protocol` carries no curve, so a test of it that
 * imported one would give the whole suite a dependency the source does not
 * have. Its discrete log is trivial, so it proves nothing about SECRECY - the
 * same handout is measured under real secp256k1 in
 * `arena-node/test/shares-feldman.test.js`, where a curve already lives.
 */
const zn = {
  pointFromScalar(k) {
    const out = new Uint8Array(33);
    let v = ((k % FIELD) + FIELD) % FIELD;
    for (let i = 32; i >= 1; i--) { out[i] = Number(v & 255n); v >>= 8n; }
    return out;
  },
  combinePoints(terms) {
    let sum = 0n;
    for (const { point, coefficient } of terms) {
      let v = 0n;
      for (let i = 1; i < 33; i++) v = (v << 8n) | BigInt(point[i]);
      sum = (sum + v * (((coefficient % FIELD) + FIELD) % FIELD)) % FIELD;
    }
    return zn.pointFromScalar(sum);
  },
};

test('a split with a group publishes one commitment per coefficient, and every signer node lies on it', () => {
  const out = splitSecret(preimage, { coefficients, curve: zn });
  assert.equal(out.commitments.length, SHARES_NEEDED,
    'a threshold of five is a polynomial of five coefficients');
  for (const c of out.commitments) assert.equal(c.length, 33);

  for (const share of out.shares) {
    const seen = shareOpensTo(share, { commitments: out.commitments, curve: zn });
    assert.equal(seen.ok, true, seen.why);
  }

  // AND THE CONSTANT TERM IS THE ONE THE PREIMAGE NAMES: C_0 is g^P, which is
  // why the check tells a signer node nothing it did not already have.
  assert.deepEqual(out.commitments[0], zn.pointFromScalar(BigInt('0x' + toHex(preimage))));
});

test('a signer node with no polynomial, or no group, refuses rather than approving', () => {
  const out = splitSecret(preimage, { coefficients, curve: zn });
  const share = out.shares[0];

  // THE ANSWER, NOT ONLY THE SENTENCE. A mutant that kept every one of these
  // messages and returned ok:true survived the first version of this test:
  // "I was given no way to check" read as "I checked and it is fine", which is
  // the whole layer made optional at the dealer's choice.
  for (const [what, given] of [
    ['no commitments at all', { curve: zn }],
    ['an empty list of them', { commitments: [], curve: zn }],
    ['no group', { commitments: out.commitments }],
    ['a group with no operations', { commitments: out.commitments, curve: {} }],
  ]) {
    const seen = shareOpensTo(share, given);
    assert.equal(seen.ok, false, `${what} was accepted as a check that passed`);
    assert.match(seen.why, /names no polynomial|needs a group/);
  }
  assert.equal(shareOpensTo(share, { commitments: out.commitments, curve: zn }).ok, true);

  // and a handout nobody can check is a handout that is refused, signer node by signer node
  const blind = checkHandout({ shares: out.shares, curve: zn });
  assert.equal(blind.refused, 7, blind.why);
  assert.equal(blind.ok, false);
});

/**
 * THE FIGURE THIS LETTER MOVES.
 *
 * The same two-polynomial dealer the file already builds: three signer nodes are
 * handed a share from a second polynomial. Every one of the seven still passes
 * its own hash commitment - that check is about transit, and the dealer wrote
 * both sides of it - and none of the twenty-one five-subsets can open the
 * committed preimage, so the stake could never be settled.
 *
 * With the polynomial published, those three signer nodes refuse the share at
 * HANDOUT. The 0-of-21 handout stops being something the committee discovers
 * at settlement and becomes something the signer nodes reject before play.
 */
test('a two-polynomial dealer is refused at handout: 0 of 7 becomes 3 of 7', () => {
  const other = new Uint8Array(randomBytes(32));
  const honest = splitSecret(preimage, { coefficients, curve: zn });
  const second = splitSecret(other, { coefficients: coefficients.map((x) => x + 99n), curve: zn });
  const stakeCommitment = sha256(preimage);

  const mixed = honest.shares.map((s, i) => (i >= 4 ? second.shares[i] : s));
  const published = honest.shares.map((s, i) => (i >= 4 ? second.shares[i].commitment : s.commitment));

  // BEFORE: the hash commitments alone see nothing wrong.
  const transitOnly = mixed.filter((s, i) => !shareIsConsistent(s, published[i])).length;
  assert.equal(transitOnly, 0, 'the per-share commitments were supposed to be blind to this');

  // and the committee finds out at settlement, too late, with no way to settle
  const opened = openStake(mixed, { stakeCommitment });
  assert.equal(opened.subsets, 21);
  assert.equal(opened.opens, 0);
  assert.equal(handoutOutcome(opened).outcome, 'FORFEIT');

  // AFTER: the three signer nodes given the second polynomial refuse their share.
  const handout = checkHandout({ shares: mixed, published, commitments: honest.commitments, curve: zn });
  assert.equal(handout.refused, 3, handout.why);
  assert.equal(handout.accepted, 4);
  assert.equal(handout.ok, false);
  assert.deepEqual(handout.signerNodes.filter((s) => !s.ok).map((s) => s.signerNode), [5, 6, 7]);
  assert.match(handout.why, /not on the polynomial the dealer published/);

  console.log(`  two-polynomial dealer: refused at handout ${transitOnly} of 7 with the hash `
    + `commitments alone, ${handout.refused} of 7 with the polynomial published`);

  // AND THE HONEST DEALER IS UNTOUCHED.
  const good = checkHandout({ shares: honest.shares, commitments: honest.commitments, curve: zn });
  assert.equal(good.refused, 0, good.why);
  assert.equal(good.ok, true);
  assert.equal(openStake(honest.shares, { stakeCommitment }).opens, 21);
});

test('one door answers both questions, and two arguments is still the old one', () => {
  const other = new Uint8Array(randomBytes(32));
  const honest = splitSecret(preimage, { coefficients, curve: zn });
  const second = splitSecret(other, { coefficients: coefficients.map((x) => x + 99n), curve: zn });
  const mixed = honest.shares.map((s, i) => (i >= 4 ? second.shares[i] : s));
  const published = honest.shares.map((s, i) => (i >= 4 ? second.shares[i].commitment : s.commitment));

  // TWO ARGUMENTS: the hash commitment alone, blind to the dealer, as before.
  assert.equal(mixed.filter((s, i) => !shareIsConsistent(s, published[i])).length, 0);

  // THREE: the same call also asks whether the share is on the polynomial.
  const refused = mixed.filter((s, i) =>
    !shareIsConsistent(s, published[i], { commitments: honest.commitments, curve: zn }));
  assert.equal(refused.length, 3);
  assert.deepEqual(refused.map((s) => s.signerNode), [5, 6, 7]);

  // an honest signer node passes both ways, and a corrupted value fails both
  assert.equal(shareIsConsistent(honest.shares[0], honest.shares[0].commitment,
    { commitments: honest.commitments, curve: zn }), true);
  const bent = { ...honest.shares[0], value: honest.shares[0].value + 1n };
  assert.equal(shareIsConsistent(bent, honest.shares[0].commitment), false);
  assert.equal(shareIsConsistent(bent, honest.shares[0].commitment,
    { commitments: honest.commitments, curve: zn }), false);
});
