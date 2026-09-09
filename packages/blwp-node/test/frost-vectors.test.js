// RFC 9591'S OWN NUMBERS, NOT OURS.
//
// PRIORITIES calls FROST "comparatively low risk despite sounding like the
// hardest part" for exactly one reason: it has published test vectors, so the
// implementation can be measured against numbers somebody else wrote down.
// `test-vectors/protocol/rfc9591-secp256k1.json` is Appendix E.5, pulled out
// of the RFC text by a script rather than typed.
//
// This file lives in `blwp-node` because `packages/protocol` carries no curve
// on purpose and every point operation here needs one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  H1, H2, H3, H4, H5, CONTEXT, SIGNATURE_BYTES,
  encodeCommitmentList, bindingFactors, groupCommitment, challenge,
  interpolatingValue, signShare, aggregate, verify, trustedDealerSplit,
  nonceGenerate,
} from '../../protocol/src/frost.js';
import { scalarFrom32, scalarTo32 } from '../../protocol/src/shares.js';
import { feldmanGroup } from '../src/curve.js';
import { fromHex, toHex } from '../../protocol/src/hash.js';

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

test('the vector file is the RFC\'s, and says where it came from', () => {
  assert.equal(V.source, 'https://www.rfc-editor.org/rfc/rfc9591.txt');
  assert.equal(V.ciphersuite, CONTEXT);
  assert.equal(V.config.maxParticipants, 3);
  assert.equal(V.config.minParticipants, 2);
  assert.deepEqual(signers, ['1', '3']);
  assert.equal(hex(V.signature).length, SIGNATURE_BYTES);
});

test('a trusted dealer reproduces the RFC\'s three shares and its group key', () => {
  const dealt = trustedDealerSplit({
    secret: hex(V.group.secretKey),
    max: V.config.maxParticipants,
    min: V.config.minParticipants,
    coefficients: V.group.polynomialCoefficients.map(scalar),
    curve: feldmanGroup,
  });
  assert.equal(toHex(dealt.groupPublicKey), V.group.publicKey);
  for (const id of ['1', '2', '3']) {
    const mine = dealt.shares.find((s) => String(s.id) === id);
    assert.equal(toHex(scalarTo32(mine.share)), V.shares[id],
      `participant ${id}'s share is not the RFC's`);
  }
  // AND THE COMMITMENT TO THE CONSTANT TERM IS THE GROUP KEY, which is what
  // lets a participant check its own share without learning the secret.
  assert.equal(toHex(dealt.commitments[0]), V.group.publicKey);
});

test('the nonces come out of the RFC\'s randomness, both of them, for both signers', () => {
  for (const id of signers) {
    const r = V.round1[id];
    const share = scalar(V.shares[id]);
    assert.equal(toHex(scalarTo32(nonceGenerate(hex(r.hidingNonceRandomness), share))),
      r.hidingNonce, `participant ${id}'s hiding nonce`);
    assert.equal(toHex(scalarTo32(nonceGenerate(hex(r.bindingNonceRandomness), share))),
      r.bindingNonce, `participant ${id}'s binding nonce`);
    // And the commitments are those nonces' points.
    assert.equal(toHex(feldmanGroup.pointFromScalar(scalar(r.hidingNonce))),
      r.hidingNonceCommitment);
    assert.equal(toHex(feldmanGroup.pointFromScalar(scalar(r.bindingNonce))),
      r.bindingNonceCommitment);
  }
});

test('the binding factors and their inputs are the RFC\'s, byte for byte', () => {
  const factors = bindingFactors({ groupPublicKey, commitments, message });
  assert.equal(factors.length, 2);
  for (const f of factors) {
    const want = V.round1[String(f.id)];
    assert.equal(toHex(f.input), want.bindingFactorInput,
      `participant ${f.id}'s binding factor input`);
    assert.equal(toHex(scalarTo32(f.factor)), want.bindingFactor,
      `participant ${f.id}'s binding factor`);
  }

  // THE LIST IS SORTED AND THE ORDER IS IN THE HASH. Two signers who sorted it
  // differently would compute different factors, and their shares would add up
  // to nothing.
  const shuffled = [...commitments].reverse();
  assert.equal(toHex(encodeCommitmentList(shuffled)), toHex(encodeCommitmentList(commitments)));
  assert.throws(() => encodeCommitmentList([commitments[0], commitments[0]]),
    /two commitments for participant 1 are one commitment/);
});

test('the signature shares are the RFC\'s, and so is the signature they aggregate to', () => {
  const shares = [];
  for (const id of signers) {
    const r = V.round1[id];
    const z = signShare({
      id: Number(id), share: scalar(V.shares[id]), groupPublicKey, message, commitments,
      nonces: {
        hiding: scalar(r.hidingNonce), binding: scalar(r.bindingNonce), curve: feldmanGroup,
      },
    });
    assert.equal(toHex(scalarTo32(z)), V.round2[id], `participant ${id}'s signature share`);
    shares.push(z);
  }

  const out = aggregate({ commitments, message, groupPublicKey, shares, curve: feldmanGroup });
  assert.equal(toHex(out.signature), V.signature, 'the aggregate is not the RFC\'s signature');

  // AND IT VERIFIES THE WAY A STRANGER WOULD CHECK IT, by Appendix B rather
  // than by re-running the construction.
  const seen = verify({ signature: out.signature, groupPublicKey, message, curve: feldmanGroup });
  assert.equal(seen.ok, true, seen.why);
});

test('one signer of the two produces nothing that verifies', () => {
  // BELOW THE THRESHOLD THERE IS NOTHING TO ADD UP. The Lagrange coefficient
  // depends on WHO ELSE is signing, so a lone signer cannot even compute the
  // contribution it would need - and a signature built from its share alone is
  // refused by the RFC's own check.
  const id = signers[0];
  const r = V.round1[id];
  const alone = [{ id: Number(id), hiding: hex(r.hidingNonceCommitment),
    binding: hex(r.bindingNonceCommitment) }];
  const z = signShare({
    id: Number(id), share: scalar(V.shares[id]), groupPublicKey, message, commitments: alone,
    nonces: { hiding: scalar(r.hidingNonce), binding: scalar(r.bindingNonce), curve: feldmanGroup },
  });
  const out = aggregate({ commitments: alone, message, groupPublicKey, shares: [z], curve: feldmanGroup });
  const seen = verify({ signature: out.signature, groupPublicKey, message, curve: feldmanGroup });
  assert.equal(seen.ok, false, 'one signer of a 2-of-3 produced a valid group signature');
  assert.match(seen.why, /not a signature of this group over this message/);
});

test('a signer outside the set, and a set naming one signer twice, are refused', () => {
  assert.throws(() => interpolatingValue([1, 3], 2), /participant 2 is not in that signing set/);
  assert.throws(() => interpolatingValue([1, 1], 1), /naming one participant twice/);
  assert.throws(() => signShare({
    id: 2, share: scalar(V.shares['2']), groupPublicKey, message, commitments,
    nonces: { hiding: 1n, binding: 1n, curve: feldmanGroup },
  }), /participant 2 did not commit to this signature/);
});

test('the five hashes are domain separated from each other', () => {
  // Every one of H1..H5 is the same SHA-256 over the same message under a
  // different label. Sharing a label would mean a binding factor could be
  // produced by asking for a challenge.
  const m = new Uint8Array([1, 2, 3]);
  const seen = new Set([
    toHex(scalarTo32(H1(m))), toHex(scalarTo32(H2(m))), toHex(scalarTo32(H3(m))),
    toHex(H4(m)), toHex(H5(m)),
  ]);
  assert.equal(seen.size, 5, 'two of the five hashes agree, so they are not separated');
});
