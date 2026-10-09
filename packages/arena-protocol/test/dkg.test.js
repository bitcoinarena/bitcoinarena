// THE EPOCH, AND THE CONTRIBUTION ON THE WIRE - the half of item 14 that needs
// no curve.
//
// This package carries no crypto on purpose, so the arithmetic half of the DKG
// is measured in `arena-node/test/dkg.test.js` where a curve is injected, the
// same split `shares.test.js` and `shares-feldman.test.js` already keep. What
// is here is what a byte order and a hash decide: which committee a key
// belongs to, and whether a contribution can be replayed into another one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { epochId, encodeContribution, decodeContribution, contributionId, acceptContribution } from '../src/dkg.js';
import { VSS_SEALED_BYTES } from '../src/seal.js';
import { toHex } from '../src/hash.js';

const rand = (n) => new Uint8Array(randomBytes(n));
const keys = (n) => Array.from({ length: n }, () => rand(32));

/** A contribution's SHAPE, with no curve anywhere near it. */
const shaped = (signerNodes, from, id) => ({
  epochId: id, from, ephemeralPubkey: rand(32), needed: 5,
  commitments: Array.from({ length: 5 }, () => rand(33)),
  proof: rand(64),
  shares: signerNodes.map((k, i) => ({ signerNode: i + 1, signerNodePubkey: k, sealed: rand(VSS_SEALED_BYTES) })),
});

test('the epoch is the signer nodes themselves, in any order, and a different committee is a different epoch', () => {
  const signerNodes = keys(7);
  const id = epochId(signerNodes);
  assert.equal(id.length, 32);

  // TWO NODES HOLDING ONE COMMITTEE IN TWO ORDERS COMPUTE ONE ID. The signer nodes
  // arrive from a store that sorts by pubkey and from a contract that sorts
  // its own way; one committee must not be two epochs.
  assert.deepEqual(epochId([...signerNodes].reverse()), id);
  assert.deepEqual(epochId([...signerNodes].sort((x, y) => (toHex(x) < toHex(y) ? 1 : -1))), id);

  // A DIFFERENT COMMITTEE IS A DIFFERENT EPOCH, which is what makes "the same
  // seven keep the same key until the committee changes" a rule and not a hope.
  assert.notDeepEqual(epochId(keys(7)), id);
  assert.notDeepEqual(epochId(signerNodes.slice(0, 6)), id, 'dropping a signer node did not change the epoch');
  assert.notDeepEqual(epochId([...signerNodes, rand(32)]), id, 'adding a signer node did not change the epoch');

  assert.throws(() => epochId([]), /that is nobody/);
  assert.throws(() => epochId([signerNodes[0], signerNodes[0]]), /are one key/);
});

test('a contribution survives the wire, and its id binds the epoch and the dealer', () => {
  const signerNodes = keys(7);
  const id = epochId(signerNodes);
  const one = shaped(signerNodes, signerNodes[0], id);

  const back = decodeContribution(encodeContribution(one));
  assert.deepEqual(back.epochId, one.epochId);
  assert.deepEqual(back.from, one.from);
  assert.equal(back.needed, one.needed);
  assert.equal(back.commitments.length, 5);
  assert.equal(back.shares.length, 7);
  assert.equal(toHex(encodeContribution(back)), toHex(encodeContribution(one)));

  // THE EPOCH IS INSIDE THE ID, so a contribution dealt to one committee
  // cannot be replayed into another under the same name.
  assert.notEqual(toHex(contributionId({ ...one, epochId: epochId(keys(7)) })),
    toHex(contributionId(one)));

  // AND SO IS THE DEALER: every signer node contributes once, and a combine that
  // counted one signer node twice would let it deal again after seeing the others.
  assert.notEqual(toHex(contributionId({ ...one, from: signerNodes[1] })), toHex(contributionId(one)));
});

test('a contribution that could not be used is refused by shape', () => {
  const signerNodes = keys(7);
  const id = epochId(signerNodes);
  const one = shaped(signerNodes, signerNodes[0], id);
  // SHAPE PASSES, AND THEN THE DEALER'S PROOF OF KNOWLEDGE IS WHAT IS ASKED -
  // which needs a curve, and this package carries none. A contribution nobody
  // can check the proof of is not accepted; the accepted case is measured in
  // arena-node/test/dkg.test.js, with a curve.
  assert.match(acceptContribution(one).why, /checking a proof of knowledge needs a curve/);

  // A threshold that disagrees with the polynomial is a different polynomial,
  // not a shorter list.
  assert.match(acceptContribution({ ...one, needed: 4 }).why, /is a polynomial of 4 coefficients/);
  assert.match(acceptContribution({ ...one, shares: [] }).why, /no shares/);
  assert.match(acceptContribution({ ...one, commitments: [] }).why, /publishes no polynomial/);

  // Signer node zero IS the secret, and two shares for one signer node are one share.
  const atZero = { ...one, shares: [{ ...one.shares[0], signerNode: 0 }, ...one.shares.slice(1)] };
  assert.match(acceptContribution(atZero).why, /signer node zero is a share of the secret itself/);
  const twice = { ...one, shares: [one.shares[0], { ...one.shares[1], signerNode: 1 }, ...one.shares.slice(2)] };
  assert.match(acceptContribution(twice).why, /two shares for signer node 1/);

  // AND THE DEALER MUST BE ONE OF THE RECIPIENTS. A signer node that dealt to
  // everybody but itself holds no share of its own contribution and could
  // never sign with the key it helped make.
  assert.match(acceptContribution({ ...one, from: rand(32) }).why, /not on/);
});
