// THE SAME HANDOUT, UNDER THE CURVE THIS SYSTEM ACTUALLY USES.
//
// `packages/protocol` carries no curve on purpose, so its own test of this
// rule runs the algebra in Z_n - a real group whose discrete log is trivial.
// That proves the RULE and nothing about secrecy. This file is where a curve
// lives, so this is where the rule is measured on secp256k1: the same curve as
// the bonds and BIP-340, and no second group anywhere in the project.
//
// 23.1 wants a node to "confirm its share is consistent without reconstructing
// P". That is what is measured here, on the dealer the protocol suite already
// builds: a player who splits with two polynomials.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';

import { splitSecret, shareOpensTo, checkHandout, shareIsConsistent, openStake,
  handoutOutcome, FIELD, SHARES_NEEDED } from '../../arena-protocol/src/shares.js';
import { feldmanGroup, pointFromScalar } from '../src/curve.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const scalar = (bytes) => BigInt('0x' + toHex(bytes));
const preimage = new Uint8Array(randomBytes(32));
const coefficients = [1n, 2n, 3n, 4n].map((n) => n * 0x1234567890abcdefn + 7n);

test('every signer node of an honest handout lies on the published polynomial', () => {
  const out = splitSecret(preimage, { coefficients, curve: feldmanGroup });

  assert.equal(out.commitments.length, SHARES_NEEDED);
  for (const c of out.commitments) {
    assert.equal(c.length, 33, 'a commitment is a compressed point');
    assert.ok(c[0] === 2 || c[0] === 3, 'that is not a compressed point');
  }

  const handout = checkHandout({ shares: out.shares, commitments: out.commitments,
    curve: feldmanGroup });
  assert.equal(handout.refused, 0, handout.why);
  assert.equal(handout.accepted, 7);
  assert.equal(openStake(out.shares, { stakeCommitment: sha256(preimage) }).opens, 21);
});

test('the first commitment is the preimage\'s own point, and no share is the preimage', () => {
  const out = splitSecret(preimage, { coefficients, curve: feldmanGroup });
  assert.deepEqual(out.commitments[0], pointFromScalar(scalar(preimage)),
    'C_0 is g^P, which is what lets a signer node check without learning P');

  // WHAT THE CHECK DOES NOT LEAK. A signer node holds one point of the polynomial and
  // g^P; recovering P from either is the discrete log of this curve. What can
  // be asserted here rather than argued is the shape: no share IS P, and no
  // commitment is the preimage's bytes.
  for (const share of out.shares)
    assert.notEqual(share.value, scalar(preimage), 'a share handed over the secret itself');
  for (const c of out.commitments)
    assert.notEqual(toHex(c).slice(2), toHex(preimage), 'a commitment is the preimage in the clear');
});

test('a two-polynomial dealer is refused at handout: 0 of 7 becomes 3 of 7', () => {
  const other = new Uint8Array(randomBytes(32));
  const honest = splitSecret(preimage, { coefficients, curve: feldmanGroup });
  const second = splitSecret(other, { coefficients: coefficients.map((x) => x + 99n),
    curve: feldmanGroup });
  const stakeCommitment = sha256(preimage);

  const mixed = honest.shares.map((s, i) => (i >= 4 ? second.shares[i] : s));
  const published = honest.shares.map((s, i) => (i >= 4 ? second.shares[i].commitment : s.commitment));

  // BEFORE: the per-share hash commitments see nothing. The dealer wrote both
  // sides of that check, so it was never going to.
  const blind = mixed.filter((s, i) => !shareIsConsistent(s, published[i])).length;
  assert.equal(blind, 0);

  // and the committee finds out at settlement, when there is nothing to do
  const opened = openStake(mixed, { stakeCommitment });
  assert.equal(opened.opens, 0);
  assert.equal(opened.subsets, 21);
  assert.equal(handoutOutcome(opened).outcome, 'FORFEIT');

  // AFTER: the three signer nodes holding the second polynomial refuse, on the curve.
  const handout = checkHandout({ shares: mixed, published,
    commitments: honest.commitments, curve: feldmanGroup });
  assert.equal(handout.refused, 3, handout.why);
  assert.deepEqual(handout.signerNodes.filter((s) => !s.ok).map((s) => s.signerNode), [5, 6, 7]);
  assert.equal(handout.ok, false);

  console.log(`  secp256k1: refused at handout ${blind} of 7 by the hash commitments, `
    + `${handout.refused} of 7 by the polynomial`);
});

test('the signer node number is part of the check, so two shares cannot be swapped', () => {
  const out = splitSecret(preimage, { coefficients, curve: feldmanGroup });

  // A share is a POINT of the polynomial, and which point depends on the signer node.
  // Handing signer node 2's value to signer node 3 passes nothing, even though both values
  // came from the one honest dealer.
  const swapped = { signerNode: 3, value: out.shares[1].value };
  const seen = shareOpensTo(swapped, { commitments: out.commitments, curve: feldmanGroup });
  assert.equal(seen.ok, false);
  assert.match(seen.why, /signer node 3 was handed a share that is not on the polynomial/);

  // and one bit is enough
  const bumped = { signerNode: 1, value: out.shares[0].value + 1n };
  assert.equal(shareOpensTo(bumped, { commitments: out.commitments, curve: feldmanGroup }).ok, false);
});

test('commitments from another dealer do not vouch for this handout', () => {
  const mine = splitSecret(preimage, { coefficients, curve: feldmanGroup });
  const theirs = splitSecret(new Uint8Array(randomBytes(32)),
    { coefficients: coefficients.map((x) => x + 5n), curve: feldmanGroup });

  const handout = checkHandout({ shares: mine.shares, commitments: theirs.commitments,
    curve: feldmanGroup });
  assert.equal(handout.refused, 7, 'somebody else\'s polynomial vouched for these shares');
});

test('a preimage at or above the order is refused on this curve too', () => {
  const tooBig = new Uint8Array(32).fill(0xff);
  assert.ok(scalar(tooBig) > FIELD);
  assert.throws(() => splitSecret(tooBig, { coefficients, curve: feldmanGroup }),
    /not below the group order/);
});
