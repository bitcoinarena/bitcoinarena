// A 5-OF-7 SIGNATURE THAT BITCOIN'S OWN VERIFIER ACCEPTS.
//
// `frost-vectors.test.js` proves the algebra against RFC 9591's published
// numbers. That suite is not BIP-340 and nothing on the Bitcoin network would
// check a signature it produces, so this is the same threshold over BIP-340's
// conventions - x-only keys, even-y, the tagged challenge - and the check is
// NOT ours: it is `schnorr.verify`, the same one a taproot output uses.
//
// The measurement this letter closes on:
//
//   one signer of seven    nothing that verifies
//   four of seven          refused by name, before any bytes exist
//   five of seven          verifies under BIP-340 against one 32-byte key
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';

import { trustedDealerSplit, nonceGenerate } from '../../protocol/src/frost.js';
import {
  signShare340, aggregate340, enoughToSign, evenGroupSecret, xOnly, hasEvenY,
  SIGNATURE_BYTES,
} from '../../protocol/src/frost-bip340.js';
import { scalarFrom32, scalarTo32, FIELD, SHARES_NEEDED, SHARES_TOTAL } from '../../protocol/src/shares.js';
import { feldmanGroup } from '../src/curve.js';
import { toHex, sha256 } from '../../protocol/src/hash.js';

const rand = (n) => new Uint8Array(randomBytes(n));
const MESSAGE = sha256(new TextEncoder().encode('the pool pays out'));

/** A 5-of-7 committee, dealt once, with the group key normalised to even y. */
function committee(secretBytes = rand(32)) {
  const even = evenGroupSecret(scalarFrom32(secretBytes) % FIELD, feldmanGroup);
  const dealt = trustedDealerSplit({
    secret: even.secret, max: SHARES_TOTAL, min: SHARES_NEEDED,
    coefficients: Array.from({ length: SHARES_NEEDED - 1 }, () => scalarFrom32(rand(32)) % FIELD),
    curve: feldmanGroup,
  });
  assert.equal(toHex(dealt.groupPublicKey), toHex(even.point));
  return dealt;
}

/** What each signer publishes in round one, from its own randomness. */
function commit(dealt, ids) {
  return ids.map((id) => {
    const share = dealt.shares.find((s) => s.id === id).share;
    const hiding = nonceGenerate(rand(32), share);
    const binding = nonceGenerate(rand(32), share);
    return {
      id, share, hiding, binding,
      commitment: {
        id,
        hiding: feldmanGroup.pointFromScalar(hiding),
        binding: feldmanGroup.pointFromScalar(binding),
      },
    };
  });
}

function sign(dealt, signers, message = MESSAGE) {
  const commitments = signers.map((s) => s.commitment);
  const shares = signers.map((s) => signShare340({
    id: s.id, share: s.share, groupPublicKey: dealt.groupPublicKey,
    nonces: { hiding: s.hiding, binding: s.binding },
    message, commitments, curve: feldmanGroup,
  }));
  return aggregate340({
    commitments, message, groupPublicKey: dealt.groupPublicKey, shares, curve: feldmanGroup,
  });
}

test('the group key is one 32-byte x-only key with even y', () => {
  for (let i = 0; i < 8; i++) {
    const dealt = committee();
    assert.equal(dealt.groupPublicKey.length, 33);
    assert.equal(hasEvenY(dealt.groupPublicKey), true,
      'a group key with odd y names a key nobody can sign for');
    assert.equal(xOnly(dealt.groupPublicKey).length, 32);
    assert.equal(dealt.shares.length, 7);
  }
});

test('five of seven produce a signature BIP-340 accepts, and it is 64 bytes', () => {
  // The verifier is schnorr.verify - the same check a taproot spend gets - so
  // this is not the construction agreeing with itself.
  let verified = 0;
  for (let i = 0; i < 8; i++) {
    const dealt = committee();
    const who = [1, 2, 3, 4, 5, 6, 7].sort(() => (randomBytes(1)[0] < 128 ? -1 : 1)).slice(0, 5);
    const out = sign(dealt, commit(dealt, who));
    assert.equal(out.signature.length, SIGNATURE_BYTES);
    if (schnorr.verify(out.signature, MESSAGE, xOnly(dealt.groupPublicKey))) verified++;
  }
  assert.equal(verified, 8, 'a 5-of-7 signature was not accepted by BIP-340');
});

test('any five of the seven sign for the same key, and the key never moves', () => {
  const dealt = committee();
  const key = xOnly(dealt.groupPublicKey);
  const sets = [[1, 2, 3, 4, 5], [3, 4, 5, 6, 7], [1, 3, 5, 6, 7], [2, 4, 5, 6, 7]];
  for (const who of sets) {
    const out = sign(dealt, commit(dealt, who));
    assert.equal(schnorr.verify(out.signature, MESSAGE, key), true,
      `${who.join(',')} could not sign for the committee's key`);
    assert.equal(toHex(out.publicKey), toHex(key), 'the key changed with the signers');
  }
});

test('four of seven is refused by name, before any bytes exist', () => {
  const dealt = committee();
  const four = commit(dealt, [1, 2, 3, 4]).map((s) => s.commitment);
  const seen = enoughToSign({ commitments: four, needed: SHARES_NEEDED });
  assert.equal(seen.ok, false);
  assert.match(seen.why, /4 of 5 signers: a pool nobody can move stays where it is/);
  assert.equal(enoughToSign({ commitments: [], needed: SHARES_NEEDED }).ok, false);
  assert.equal(enoughToSign({
    commitments: [four[0], four[0]].concat(four.slice(1)), needed: 3,
  }).ok, false);
});

test('four of seven that sign anyway produce nothing BIP-340 accepts', () => {
  // The refusal above is a courtesy. The property underneath it is that four
  // shares do not add up to a signature for this key at all: the interpolating
  // value of each signer depends on WHO ELSE signed, so a set of four computes
  // contributions to a different secret.
  const dealt = committee();
  const key = xOnly(dealt.groupPublicKey);
  let accepted = 0;
  for (const who of [[1, 2, 3, 4], [3, 4, 5, 6], [1, 4, 6, 7]]) {
    const out = sign(dealt, commit(dealt, who));
    if (schnorr.verify(out.signature, MESSAGE, key)) accepted++;
  }
  assert.equal(accepted, 0, 'four of seven moved the pool');
});

test('one node alone produces nothing BIP-340 accepts', () => {
  const dealt = committee();
  const key = xOnly(dealt.groupPublicKey);
  let accepted = 0;
  for (const id of [1, 2, 3, 4, 5, 6, 7]) {
    const out = sign(dealt, commit(dealt, [id]));
    if (schnorr.verify(out.signature, MESSAGE, key)) accepted++;
  }
  assert.equal(accepted, 0, 'a single operator signed for the committee');
});

test('a signature is over ONE message, and a signer with a stale share is caught', () => {
  const dealt = committee();
  const key = xOnly(dealt.groupPublicKey);
  const signers = commit(dealt, [1, 2, 3, 4, 5]);
  const out = sign(dealt, signers);
  assert.equal(schnorr.verify(out.signature, MESSAGE, key), true);

  // ANOTHER MESSAGE IS ANOTHER SIGNATURE. A pool spend signed for one payout
  // table must not verify against a different one.
  const other = sha256(new TextEncoder().encode('the pool pays somebody else'));
  assert.equal(schnorr.verify(out.signature, other, key), false);

  // AND A SHARE FROM ANOTHER DEALING IS NOT A SHARE OF THIS ONE.
  const stranger = committee();
  const swapped = signers.map((s, i) => (i === 0
    ? { ...s, share: stranger.shares.find((x) => x.id === s.id).share } : s));
  assert.equal(schnorr.verify(sign(dealt, swapped).signature, MESSAGE, key), false,
    'a share from another committee signed for this one');
});

test('the odd-y group commitment is handled, and it comes up about half the time', () => {
  // R cannot be normalised in advance - it depends on whoever turned up - so
  // every signer reads its parity off the public commitment list and negates
  // its own nonces when it is odd. If that were missing, roughly half of all
  // signatures would fail, which is what this counts.
  const dealt = committee();
  const key = xOnly(dealt.groupPublicKey);
  let odd = 0, verified = 0;
  for (let i = 0; i < 24; i++) {
    const out = sign(dealt, commit(dealt, [1, 2, 3, 4, 5]));
    if (!hasEvenY(out.commitment)) odd++;
    if (schnorr.verify(out.signature, MESSAGE, key)) verified++;
  }
  assert.equal(verified, 24, 'a signature failed, which is the parity fix missing');
  assert.ok(odd >= 4 && odd <= 20, `the group commitment was odd ${odd} times of 24, which is not a coin`);
});

test('a group key with odd y is refused rather than signed for', () => {
  const dealt = committee();
  const odd = new Uint8Array(dealt.groupPublicKey);
  odd[0] = 0x03;
  assert.throws(() => signShare340({
    id: 1, share: dealt.shares[0].share, groupPublicKey: odd,
    nonces: { hiding: 1n, binding: 2n }, message: MESSAGE,
    commitments: commit(dealt, [1, 2, 3, 4, 5]).map((s) => s.commitment), curve: feldmanGroup,
  }), /odd y: normalise the secret when it is dealt/);
});
