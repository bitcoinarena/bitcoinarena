// ZCASH FOUNDATION'S frost-secp256k1-tr v3.0.0, BYTE FOR BYTE.
//
// FEDERATION.md's condition before real money: "FROST and DKG bit-matched
// against Zcash Foundation frost-secp256k1-tr". The vectors are ZF's own files,
// pinned by tag and sha256 in test-vectors/protocol/zf-frost-secp256k1-tr-v3.0.0.
//
// Measured before this: our BIP-340 FROST hashed under RFC 9591's context
// string, so ZF's nonces, binding factors, signature shares and signature all
// came out different (14 of 38 values matched). With the taproot context
// string - the one difference - all of them match. Our DKG needed no change:
// its shares, made even and moved by the pool's BIP-341 tweak, are ZF's.
//
// Lives in blwp-node because packages/protocol carries no curve on purpose.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';

import { trustedDealerSplit, bindingFactors } from '../../protocol/src/frost.js';
import { TR_CONTEXT, nonceGenerate340, signShare340, aggregate340, verifyShare340 } from '../../protocol/src/frost-bip340.js';
import { splitSecret, scalarFrom32, scalarTo32, FIELD } from '../../protocol/src/shares.js';
import { groupKeyOf, knowledgeIsProven } from '../../protocol/src/dkg.js';
import { poolTweak, poolShare } from '../../protocol/src/pool.js';
import { feldmanGroup as curve } from '../src/curve.js';
import { fromHex, toHex, bytesToBigInt } from '../../protocol/src/hash.js';

const DIR = new URL('../../../test-vectors/protocol/zf-frost-secp256k1-tr-v3.0.0/', import.meta.url);
const read = (f) => readFileSync(new URL(f, DIR));
const SOURCE = JSON.parse(read('SOURCE.json'));
const V = JSON.parse(read('vectors.json'));
const K = JSON.parse(read('vectors_dkg.json'));
const h = fromHex;
const sc = (s) => scalarFrom32(fromHex(s));
const s32 = (n) => toHex(scalarTo32(n));

test('the pinned files are the tag\'s own bytes', () => {
  assert.equal(SOURCE.tag, 'frost-secp256k1-tr/v3.0.0');
  assert.equal(SOURCE.contextString, TR_CONTEXT);
  for (const [name, { sha256 }] of Object.entries(SOURCE.files))
    assert.equal(createHash('sha256').update(read(name)).digest('hex'), sha256, `${name} is not the pinned file`);
});

test('signing: shares, nonces, binding factors, signature shares and the BIP-340 signature are ZF\'s', () => {
  const dealt = trustedDealerSplit({ secret: h(V.inputs.group_secret_key), max: 3, min: 2,
    coefficients: V.inputs.share_polynomial_coefficients.map(sc), curve });
  assert.equal(toHex(dealt.groupPublicKey), V.inputs.verifying_key_key);
  for (const p of V.inputs.participant_shares)
    assert.equal(s32(dealt.shares.find((s) => s.id === p.identifier).share), p.participant_share);

  const shareOf = (id) => sc(V.inputs.participant_shares.find((p) => p.identifier === id).participant_share);
  for (const o of V.round_one_outputs.outputs) {
    assert.equal(s32(nonceGenerate340(h(o.hiding_nonce_randomness), shareOf(o.identifier))), o.hiding_nonce);
    assert.equal(s32(nonceGenerate340(h(o.binding_nonce_randomness), shareOf(o.identifier))), o.binding_nonce);
    assert.equal(toHex(curve.pointFromScalar(sc(o.hiding_nonce))), o.hiding_nonce_commitment);
    assert.equal(toHex(curve.pointFromScalar(sc(o.binding_nonce))), o.binding_nonce_commitment);
  }

  const gpk = h(V.inputs.verifying_key_key);
  const message = h(V.inputs.message);
  const commitments = V.round_one_outputs.outputs.map((o) => ({
    id: o.identifier, hiding: h(o.hiding_nonce_commitment), binding: h(o.binding_nonce_commitment) }));
  const factors = bindingFactors({ groupPublicKey: gpk, commitments, message, context: TR_CONTEXT });
  for (const o of V.round_one_outputs.outputs) {
    const f = factors.find((x) => x.id === o.identifier);
    assert.equal(toHex(f.input), o.binding_factor_input);
    assert.equal(s32(f.factor), o.binding_factor);
  }

  const shares = V.round_one_outputs.outputs.map((o) => signShare340({ id: o.identifier, share: shareOf(o.identifier),
    groupPublicKey: gpk, nonces: { hiding: sc(o.hiding_nonce), binding: sc(o.binding_nonce) }, message, commitments, curve }));
  V.round_two_outputs.outputs.forEach((o, i) => assert.equal(s32(shares[i]), o.sig_share));
  const { signature } = aggregate340({ commitments, message, groupPublicKey: gpk, shares, curve });
  assert.equal(toHex(signature), V.final_output.sig);
  assert.equal(schnorr.verify(signature, message, gpk.subarray(1)), true, 'BIP-340 does not accept the signature');
});

test('DKG: commitments, round-2 shares and final key shares are ZF\'s, under our DKG and the pool\'s taproot tweak', () => {
  const ids = ['1', '2', '3'];
  const polys = {};
  for (const i of ids) {
    const P = K.inputs[i];
    polys[i] = splitSecret(h(P.signing_key), { signerNodes: 3, needed: 2, coefficients: [sc(P.coefficient)], curve });
    polys[i].commitments.forEach((c, k) => assert.equal(toHex(c), P.vss_commitments[k]));
  }
  // ZF keys `signing_shares` by SENDER, as the recipient holds them: participant
  // i's record lists f_j(i).
  for (const i of ids)
    for (const [j, v] of Object.entries(K.inputs[i].signing_shares))
      assert.equal(s32(polys[j].shares.find((s) => s.signerNode === Number(i)).value), v, `f_${j}(${i})`);

  // ZF's post-DKG step: make the key even (negating every share if not), then
  // add t = TapTweak(P.x) to every share. Ours is groupKeyOf + poolTweak +
  // poolShare; ZF keeps an odd tweaked key and negates at signing, our pool
  // negates at once - same key, so compare before that last negation.
  const gk = groupKeyOf(ids.map((i) => ({ commitments: polys[i].commitments })), curve);
  const tweak = poolTweak(gk.groupPublicKey.subarray(1));
  const Q = curve.combinePoints([{ point: gk.groupPublicKey, coefficient: 1n },
    { point: curve.pointFromScalar(bytesToBigInt(tweak) % FIELD), coefficient: 1n }]);
  assert.equal(toHex(Q), K.inputs.verifying_key);
  for (const i of ids) {
    let s = 0n;
    for (const j of ids) s = (s + polys[j].shares.find((q) => q.signerNode === Number(i)).value) % FIELD;
    const share = poolShare({ share: gk.negated ? FIELD - s : s, tweak, negated: false });
    assert.equal(s32(share), K.inputs[i].signing_share);
    assert.equal(toHex(curve.pointFromScalar(share)), K.inputs[i].verifying_share);
    // and the pool's own form, negated for an odd output key, is the same key
    const odd = Q[0] === 0x03;
    assert.equal(poolShare({ share: gk.negated ? FIELD - s : s, tweak, negated: odd }), odd ? FIELD - share : share);
  }
});

test('DKG round 1: ZF\'s published proofs of knowledge verify under our checker, and a changed proof does not', () => {
  for (const i of ['1', '2', '3']) {
    const P = K.inputs[i];
    const commitment = h(P.vss_commitments[0]);
    const proof = h(P.proof_of_knowledge);
    assert.deepEqual(knowledgeIsProven({ id: P.identifier, commitment, proof, curve }), { ok: true }, `participant ${i}`);
    const flipped = new Uint8Array(proof); flipped[40] ^= 1;
    assert.match(knowledgeIsProven({ id: P.identifier, commitment, proof: flipped, curve }).why, /does not verify/);
    assert.match(knowledgeIsProven({ id: P.identifier + 1, commitment, proof, curve }).why, /does not verify/);
    assert.match(knowledgeIsProven({ id: P.identifier, commitment, proof: proof.subarray(0, 63), curve }).why, /no 64-byte proof/);
  }
});

test('one signature share checked alone: each of ZF\'s verifies against its signer\'s public share, a changed one does not', () => {
  const gpk = h(V.inputs.verifying_key_key);
  const message = h(V.inputs.message);
  const commitments = V.round_one_outputs.outputs.map((o) => ({
    id: o.identifier, hiding: h(o.hiding_nonce_commitment), binding: h(o.binding_nonce_commitment) }));
  const publicOf = (id) => curve.pointFromScalar(sc(V.inputs.participant_shares.find((p) => p.identifier === id).participant_share));
  const check = (id, share, publicShare = publicOf(id)) =>
    verifyShare340({ id, share, publicShare, groupPublicKey: gpk, message, commitments, curve });
  const ids = V.round_two_outputs.outputs.map((o) => o.identifier);
  for (const o of V.round_two_outputs.outputs) {
    assert.equal(check(o.identifier, sc(o.sig_share)), true, `participant ${o.identifier}`);
    assert.equal(check(o.identifier, (sc(o.sig_share) + 1n) % FIELD), false, 'a changed share verified');
    const other = ids.find((i) => i !== o.identifier);
    assert.equal(check(o.identifier, sc(o.sig_share), publicOf(other)), false, 'another signer node\'s public share verified it');
    assert.equal(check(o.identifier, 0n), false, 'a zero share verified');
  }
});
