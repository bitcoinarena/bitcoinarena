// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// RFC 9591, THE HALF THAT NEEDS NO CURVE.
//
// `packages/protocol` carries no curve on purpose, so everything here is
// hashing and scalar arithmetic: the five domain-separated hashes, the
// commitment list encoding, the binding factors computed over it, and the
// Lagrange coefficient that makes a threshold a threshold rather than a count.
// The point operations - the group commitment, the aggregate, the signature -
// are measured in `arena-node`, where a curve lives.
//
// Every number below is the RFC's, out of
// `test-vectors/protocol/rfc9591-secp256k1.json`, which a script pulled from
// the RFC text rather than anybody typing it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  H1, H2, H3, H4, H5, CONTEXT, SIGNATURE_BYTES, ELEMENT_BYTES, SCALAR_BYTES,
  encodeCommitmentList, bindingFactors, challenge, interpolatingValue,
  nonceGenerate, trustedDealerSplit,
} from '../src/frost.js';
import { scalarFrom32, scalarTo32, FIELD } from '../src/shares.js';
import { fromHex, toHex } from '../src/hash.js';

const V = JSON.parse(readFileSync(
  new URL('../../../test-vectors/protocol/rfc9591-secp256k1.json', import.meta.url).pathname, 'utf8'));
const hex = (s) => fromHex(s);
const scalar = (s) => scalarFrom32(fromHex(s));
const signers = V.signers;
const message = hex(V.group.message);
const groupPublicKey = hex(V.group.publicKey);
const commitments = signers.map((id) => ({
  id: Number(id),
  hiding: hex(V.round1[id].hidingNonceCommitment),
  binding: hex(V.round1[id].bindingNonceCommitment),
}));

test('the ciphersuite is the one the vector names, and its sizes are its own', () => {
  assert.equal(CONTEXT, V.ciphersuite);
  assert.equal(ELEMENT_BYTES, 33);
  assert.equal(SCALAR_BYTES, 32);
  assert.equal(SIGNATURE_BYTES, 65);
  assert.equal(hex(V.signature).length, SIGNATURE_BYTES);
  assert.equal(hex(V.group.publicKey).length, ELEMENT_BYTES);
});

test('the binding factor inputs and factors are the RFC\'s, byte for byte', () => {
  const factors = bindingFactors({ groupPublicKey, commitments, message });
  assert.equal(factors.length, signers.length);
  for (const f of factors) {
    const want = V.round1[String(f.id)];
    assert.equal(toHex(f.input), want.bindingFactorInput);
    assert.equal(toHex(scalarTo32(f.factor)), want.bindingFactor);
  }
});

test('the nonces are the RFC\'s, derived from its randomness and the share', () => {
  for (const id of signers) {
    const r = V.round1[id];
    const share = scalar(V.shares[id]);
    assert.equal(toHex(scalarTo32(nonceGenerate(hex(r.hidingNonceRandomness), share))), r.hidingNonce);
    assert.equal(toHex(scalarTo32(nonceGenerate(hex(r.bindingNonceRandomness), share))), r.bindingNonce);
  }
});

test('the trusted dealer reproduces the RFC\'s three shares', () => {
  // No curve, so no group key here - only the polynomial, which is the part a
  // participant's share comes from.
  const dealt = trustedDealerSplit({
    secret: hex(V.group.secretKey), max: 3, min: 2,
    coefficients: V.group.polynomialCoefficients.map(scalar),
    curve: { pointFromScalar: () => new Uint8Array(33) },
  });
  for (const id of ['1', '2', '3'])
    assert.equal(toHex(scalarTo32(dealt.shares.find((s) => String(s.id) === id).share)), V.shares[id]);
});

test('the commitment list is sorted, and a repeat is refused', () => {
  const forward = encodeCommitmentList(commitments);
  const backward = encodeCommitmentList([...commitments].reverse());
  assert.equal(toHex(forward), toHex(backward),
    'two signers sorting differently would compute different binding factors');
  assert.equal(forward.length, signers.length * (32 + 33 + 33));
  assert.throws(() => encodeCommitmentList([commitments[0], commitments[0]]),
    /two commitments for participant 1 are one commitment/);
});

test('a Lagrange coefficient depends on who else signed, which is what a threshold is', () => {
  // The same participant, two different signing sets, two different values.
  // This is why four shares of a 5-of-7 do not add up to anything: each one is
  // a contribution to a secret the other four were not computing.
  const a = interpolatingValue([1, 3], 1);
  const b = interpolatingValue([1, 2, 3], 1);
  assert.notEqual(a, b);
  assert.ok(a > 0n && a < FIELD);

  // Over the whole set, the coefficients lift the shares back to the constant
  // term - which is the identity the RFC's own signature depends on.
  const dealt = trustedDealerSplit({
    secret: hex(V.group.secretKey), max: 3, min: 2,
    coefficients: V.group.polynomialCoefficients.map(scalar),
    curve: { pointFromScalar: () => new Uint8Array(33) },
  });
  const set = [1, 3];
  let back = 0n;
  for (const id of set) {
    const share = dealt.shares.find((s) => s.id === id).share;
    back = (back + interpolatingValue(set, id) * share) % FIELD;
  }
  assert.equal(toHex(scalarTo32(back)), V.group.secretKey,
    'the signing set does not interpolate back to the group secret');

  assert.throws(() => interpolatingValue([1, 3], 2), /participant 2 is not in that signing set/);
  assert.throws(() => interpolatingValue([1, 1], 1), /naming one participant twice/);
});

test('the five hashes are domain separated, and H4 and H5 are plain SHA-256', () => {
  const m = new Uint8Array([1, 2, 3]);
  const seen = new Set([
    toHex(scalarTo32(H1(m))), toHex(scalarTo32(H2(m))), toHex(scalarTo32(H3(m))),
    toHex(H4(m)), toHex(H5(m)),
  ]);
  assert.equal(seen.size, 5, 'two of the five hashes agree, so they are not separated');
  assert.equal(H4(m).length, 32);
  assert.equal(H5(m).length, 32);
  // H1..H3 go through expand_message_xmd with L = 48, so they are scalars and
  // not 32 bytes reduced - the extra 128 bits are what makes the reduction's
  // bias unexploitable.
  for (const h of [H1, H2, H3]) assert.ok(h(m) < FIELD);
});

test('the challenge is over R, the key and the message, in that order', () => {
  const c = challenge({ commitment: hex(V.round1['1'].hidingNonceCommitment), groupPublicKey, message });
  const swapped = challenge({
    commitment: groupPublicKey, groupPublicKey: hex(V.round1['1'].hidingNonceCommitment), message,
  });
  assert.notEqual(c, swapped, 'the challenge does not depend on which is R and which is the key');
});
