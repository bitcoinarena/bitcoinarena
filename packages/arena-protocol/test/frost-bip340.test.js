// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// FROST UNDER BIP-340 - frost-bip340.js on its own (kanban #145; plan comment 179, Go 2026-10-05). Until now it ran only
// inside arena-node's integration tests (60.8% of its lines from protocol's own suite). Here, on the daemons' curve
// (arena-node/src/curve.js): a 5-of-7 split of a fixed even group key, fixed signatures from two signing sets checked by the
// BIP-340 equation itself (z*G == R + c*P, R the even point of the signature's x), both parities of R, and every refusal.
//
// Measured before this file, on frost-bip340.js as it stood: enoughToSign with no threshold passed an empty set ("0 of
// undefined signers"); it took a set naming participant 0, whose share is the secret itself; signShare340 signed with zero
// nonces, which hands the signing share to whoever reads z (and threw a TypeError with none); verifyShare340 threw
// "commitments is not iterable" when given no commitments instead of answering false.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TR_CONTEXT, SIGNATURE_BYTES, nonceGenerate340, xOnly, hasEvenY, challenge340, evenGroupSecret, signShare340, aggregate340,
  enoughToSign, keyName, verifyShare340,
} from '../src/frost-bip340.js';
import { trustedDealerSplit, bindingFactors, groupCommitment } from '../src/frost.js';
import { FIELD } from '../src/shares.js';
import * as curve from '../../arena-node/src/curve.js';

const hex = (b) => Buffer.from(b).toString('hex');
const GROUP = evenGroupSecret(0x1234567890n, curve);
const DEAL = trustedDealerSplit({ secret: GROUP.secret, max: 7, min: 5, coefficients: [5n, 6n, 7n, 8n], curve });
const PK = DEAL.groupPublicKey;
const MSG = new Uint8Array(32).fill(0xab);
const V = {
  key: '02a5d3e21feff754e340441ce86ff0472c8136ee351c489adce3f4ba24ab760a73',
  a: '0376f35330e6c66133fad67326f8f06c9d60b11cb4f4edd82db15bf841ff464e581d40b09702a81265d1c6e3dff94fd4beb80756ecec2c853e7c108037262fee',
  b: 'ee9ffb0967157c5cbab9db33d9e9039dd43c816c12570f179db5aa30e42d73f5b0004980e943cc4c4d4cdba8d101ac6640a7f1f937afb8315527826c1f363ebc',
  even: 'ccb13d998307453037fd8dcbad171de22e67c4aae8af846406daec728a7815eda26ae1fc2436d34b478ff16a12204d2af3f6f2172f624ce081c62502814f95b4',
};
const shareOf = (id) => DEAL.shares[id - 1].share;
const publicShare = (id) => curve.pointFromScalar(shareOf(id));

function session(signers, salt = 0) {
  const nonces = signers.map((id) => ({ id,
    hiding: nonceGenerate340(new Uint8Array(32).fill(id + salt), shareOf(id)),
    binding: nonceGenerate340(new Uint8Array(32).fill(id + 50 + salt), shareOf(id)) }));
  const commitments = nonces.map((n) => ({ id: n.id, hiding: curve.pointFromScalar(n.hiding), binding: curve.pointFromScalar(n.binding) }));
  const shares = nonces.map((n) => signShare340({ id: n.id, share: shareOf(n.id), groupPublicKey: PK, nonces: n, message: MSG, commitments, curve }));
  const R = groupCommitment({ commitments, factors: bindingFactors({ groupPublicKey: PK, commitments, message: MSG, context: TR_CONTEXT }), curve });
  return { nonces, commitments, shares, R };
}
// BIP-340 verification on the curve: R = lift_x(sig[0..32]) (even y), z*G == R + c*P
function bip340(signature, publicKey = PK, message = MSG) {
  if (signature.length !== SIGNATURE_BYTES) return false;
  const R = Uint8Array.from([0x02, ...signature.subarray(0, 32)]);
  const z = BigInt('0x' + hex(signature.subarray(32)));
  if (z === 0n || z >= FIELD) return false;
  const c = challenge340(signature.subarray(0, 32), xOnly(publicKey), message);
  try { return hex(curve.pointFromScalar(z)) === hex(curve.combinePoints([{ point: R, coefficient: 1n }, { point: publicKey, coefficient: c }])); }
  catch { return false; }
}
const sign = (signers, salt = 0, pick = (s) => s.shares) => {
  const s = session(signers, salt);
  return aggregate340({ commitments: s.commitments, message: MSG, groupPublicKey: PK, shares: pick(s), curve });
};

// THE FIRST CHECK (plan 179): no threshold is not "enough".
test('enoughToSign refuses a set when no threshold is named, rather than passing nobody', () => {
  const got = enoughToSign({ commitments: [] });
  assert.equal(got.ok, false, `passed with nobody: ${got.why}`);
  assert.match(got.why, /threshold/);
  assert.equal(enoughToSign({ commitments: [{ id: 1 }, { id: 2 }], needed: 1 }).ok, false, 'a threshold of one is not a threshold');
  assert.equal(enoughToSign({ commitments: [{ id: 1 }, { id: 2 }], needed: '2' }).ok, false);
});

test('enoughToSign refuses a set naming participant 0 (the secret itself), or an id that is not a positive integer', () => {
  for (const bad of [0, -1, 1.5, 'x']) {
    const got = enoughToSign({ commitments: [bad, 2, 3, 4, 5].map((id) => ({ id })), needed: 5 });
    assert.equal(got.ok, false, `participant ${bad} was taken`);
    assert.match(got.why, /participant/);
  }
});

test('enoughToSign: 5 of 5 passes, 4 of 5 and one id twice are refused by name', () => {
  assert.deepEqual(enoughToSign({ commitments: [1, 3, 4, 6, 7].map((id) => ({ id })), needed: 5 }), { ok: true, why: '5 of 5 signers' });
  assert.deepEqual(enoughToSign({ commitments: [1, 3, 4, 6].map((id) => ({ id })), needed: 5 }),
    { ok: false, why: '4 of 5 signers: a pool nobody can move stays where it is' });
  assert.deepEqual(enoughToSign({ commitments: undefined, needed: 5 }), { ok: false, why: '0 of 5 signers: a pool nobody can move stays where it is' });
  assert.deepEqual(enoughToSign({ commitments: [1, 3, 4, 6, 6].map((id) => ({ id })), needed: 5 }),
    { ok: false, why: 'a signing set naming one participant twice is not a set' });
});

test('the fixed vectors: two signing sets over one key sign to pinned 64-byte signatures that verify by BIP-340', () => {
  assert.equal(hex(PK), V.key);
  assert.equal(hasEvenY(PK), true);
  assert.equal(keyName(PK), V.key.slice(2, 18));
  const a = sign([1, 3, 4, 6, 7]);
  assert.equal(hex(a.signature), V.a);
  assert.equal(hex(sign([1, 3, 4, 6, 7]).signature), V.a, 'a second run of the same session differs');
  assert.equal(a.signature.length, SIGNATURE_BYTES);
  assert.equal(hex(a.publicKey), hex(xOnly(PK)));
  assert.ok(bip340(a.signature), 'the aggregate does not verify');
  const b = sign([2, 3, 5, 6, 7]);
  assert.equal(hex(b.signature), V.b);
  assert.ok(bip340(b.signature), 'another 5-subset does not verify');
  assert.ok(!bip340(a.signature, PK, new Uint8Array(32).fill(0xac)), 'it verifies over another message');
});

test('R with odd y is flipped by every signer and the signature verifies; with even y it is left alone', () => {
  const odd = session([1, 3, 4, 6, 7], 0), even = session([1, 3, 4, 6, 7], 1);
  assert.equal(hasEvenY(odd.R), false);
  assert.equal(hasEvenY(even.R), true);
  const e = sign([1, 3, 4, 6, 7], 1);
  assert.equal(hex(e.signature), V.even);
  assert.ok(bip340(e.signature));
  assert.equal(hex(e.commitment), hex(even.R));
});

test('evenGroupSecret: an even key is kept, an odd one negated, and 0, the field order and a non-scalar are refused', () => {
  assert.equal(GROUP.secret, 0x1234567890n);
  const odd = evenGroupSecret(0x1234567891n, curve);
  assert.equal(odd.secret, FIELD - 0x1234567891n);
  assert.equal(hasEvenY(odd.point), true);
  assert.equal(hex(odd.point), hex(curve.pointFromScalar(odd.secret)));
  assert.equal(evenGroupSecret(Uint8Array.from(Buffer.from('1234567890'.padStart(64, '0'), 'hex')), curve).secret, 0x1234567890n);
  for (const bad of [0n, FIELD, 5])
    assert.throws(() => evenGroupSecret(bad, curve), { message: 'a group secret is a non-zero scalar of the group' });
});

test('signShare340 refuses by name: an odd group key, a signer not in the set, zero nonces, no nonces', () => {
  const s = session([1, 3, 4, 6, 7]);
  const base = { id: 1, share: shareOf(1), groupPublicKey: PK, nonces: s.nonces[0], message: MSG, commitments: s.commitments, curve };
  assert.throws(() => signShare340({ ...base, groupPublicKey: Uint8Array.from([0x03, ...PK.subarray(1)]) }),
    { message: 'that group key has odd y: normalise the secret when it is dealt, not here' });
  assert.throws(() => signShare340({ ...base, id: 2, share: shareOf(2) }), { message: 'participant 2 did not commit to this signature' });
  for (const nonces of [{ hiding: 0n, binding: 0n }, { hiding: 0n, binding: 5n }, { hiding: 5n, binding: FIELD }, undefined, {}])
    assert.throws(() => signShare340({ ...base, nonces }), /nonce/, `signed with nonces ${JSON.stringify(nonces, (k, v) => (typeof v === 'bigint' ? String(v) : v))}`);
});

test('verifyShare340: each share of the set is true; bent, foreign, unknown or unverifiable ones are false, never thrown', () => {
  const s = session([1, 3, 4, 6, 7]);
  const check = (i, o = {}) => verifyShare340({ id: s.nonces[i].id, share: s.shares[i], publicShare: publicShare(s.nonces[i].id),
    groupPublicKey: PK, message: MSG, commitments: s.commitments, curve, ...o });
  for (let i = 0; i < 5; i++) assert.equal(check(i), true, `signer ${s.nonces[i].id}'s share does not verify`);
  assert.equal(check(0, { share: (s.shares[0] + 1n) % FIELD }), false, 'a share off by one verified');
  assert.equal(check(0, { share: 0n }), false);
  assert.equal(check(0, { share: FIELD }), false);
  assert.equal(check(0, { share: 5 }), false);
  assert.equal(check(0, { publicShare: publicShare(3) }), false, 'another signer\'s public share verified');
  assert.equal(check(0, { id: 2 }), false, 'a signer not in the set verified');
  assert.equal(check(0, { publicShare: new Uint8Array(33).fill(9) }), false);
  assert.equal(check(0, { commitments: undefined }), false, 'missing commitments did not answer false');
  assert.equal(check(0, { commitments: 'x' }), false);
});

test('aggregate340: 4 of the 5 shares, or one share swapped for another signer\'s, do not verify', () => {
  assert.ok(!bip340(sign([1, 3, 4, 6, 7], 0, (s) => s.shares.slice(0, 4)).signature), '4 shares verified');
  assert.ok(!bip340(sign([1, 3, 4, 6, 7], 0, (s) => [session([2, 3, 4, 6, 7]).shares[0], ...s.shares.slice(1)]).signature),
    'a swapped share verified');
});

test('nonceGenerate340 is a function of its randomness and the share', () => {
  const r = new Uint8Array(32).fill(7);
  assert.equal(nonceGenerate340(r, shareOf(1)), nonceGenerate340(r, shareOf(1)));
  assert.notEqual(nonceGenerate340(r, shareOf(1)), nonceGenerate340(r, shareOf(2)));
  assert.notEqual(nonceGenerate340(r, shareOf(1)), nonceGenerate340(new Uint8Array(32).fill(8), shareOf(1)));
  assert.equal(typeof nonceGenerate340(r, shareOf(1)), 'bigint');
  assert.equal(TR_CONTEXT, 'FROST-secp256k1-SHA256-TR-v1');
});
