// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1546 refute probes that are expected to HOLD on 85f803d70: boundary lengths, distinct-key padding, drawn sets, value attestations, honest paths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createPublicKey, sign, verify } from 'node:crypto';
import { manifestBodyId, RESULT_TYPE, PAYOUT_RULE, NO_PARENT, SCALAR_SIDES } from '../src/manifest.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { encodeAttestation, decodeAttestation, attestationBodyId, attestationStands } from '../src/attested.js';
import { encodeValueAttestation, decodeValueAttestation, valueAttestationBodyId, valueAttestationStands } from '../src/scalar.js';
import { SCALAR_VERSION } from '../src/constants.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const SPKI = Buffer.from('302a300506032b6570032100', 'hex');
let calls = 0;
const vEd = (sig, msg, key) => { calls++; return verify(null, Buffer.from(msg), createPublicKey({ key: Buffer.concat([SPKI, Buffer.from(key)]), format: 'der', type: 'spki' }), Buffer.from(sig)); };
const kp = () => { const { privateKey, publicKey } = generateKeyPairSync('ed25519'); return { key: privateKey, pub: new Uint8Array(publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)) }; };
const DEV = kp();
const A = [kp(), kp(), kp()].sort((x, y) => Buffer.compare(Buffer.from(x.pub), Buffer.from(y.pub)));
const BODY = { gameName: 'btc-close', gameDevPubkey: DEV.pub, version: 1, parentManifestId: NO_PARENT, resultType: RESULT_TYPE.ATTESTED,
  cores: [], runTicksMax: 0, roundPeriodMs: 0n, payoutRule: PAYOUT_RULE.PARI_MUTUEL, rankNumerator: 0, rankDenominator: 0, minScore: 0,
  clients: [], gameDonationSetId: b32(0xd0), outcomes: ['a', 'b', 'c'], attestors: A.map((a) => a.pub), attestThreshold: 2 };
const M = { ...BODY, signature: new Uint8Array(sign(null, Buffer.from(manifestBodyId(BODY)), DEV.key)) };
const R = b32(0x77);
const body = { roundId: R, outcome: 1, observedAtMs: 1791700000000n };
const s = (a) => ({ key: a.pub, signature: new Uint8Array(sign(null, Buffer.from(attestationBodyId(body)), a.key)) });
const st = (sigs) => { calls = 0; const r = attestationStands(decodeAttestation(encodeAttestation({ ...body, signatures: sigs })), { manifest: M, roundIdBytes: R, verify: vEd }); return { ...r, calls }; };

test('honest: 2 of 3, 3 of 3 stand; boundary n+1 refused with 0 checks; n with a repeat refused by threshold', () => {
  assert.equal(st([s(A[0]), s(A[1])]).ok, true);
  assert.equal(st([s(A[0]), s(A[1]), s(A[2])]).ok, true);
  const four = st([s(A[0]), s(A[1]), s(A[2]), s(A[0])]); assert.equal(four.ok, false); assert.equal(four.calls, 0);
  const rep = st([s(A[0]), s(A[0]), s(A[0])]); assert.equal(rep.ok, false); assert.ok(rep.calls <= 3);
});
test('padding with junk / stranger keys at 65,000: 0 checks', () => {
  const junk = { key: kp().pub, signature: new Uint8Array(64) };
  const r = st([s(A[0]), s(A[1]), ...Array.from({ length: 65000 }, () => junk)]); assert.equal(r.ok, false); assert.equal(r.calls, 0);
});
test('max u16 vec 65,535 encodes and is refused with 0 checks', () => {
  const r = st(Array.from({ length: 65535 }, () => s(A[0]))); assert.equal(r.ok, false); assert.equal(r.calls, 0);
});
test('drawn: 7 drawn keys, 8 signatures refused with 0 checks; 5 of 7 BIP-340 stand', () => {
  const sks = Array.from({ length: 7 }, (_, i) => b32(i + 1)); const pks = sks.map((k) => schnorr.getPublicKey(k));
  const DM = { ...M, attestors: [], attestThreshold: 0, attestDraw: { count: 7, threshold: 5 } };
  const m = attestationBodyId(body);
  const sig = (i) => ({ key: pks[i], signature: schnorr.sign(m, sks[i]) });
  let n = 0; const vs = (g, mm, k) => { n++; return schnorr.verify(g, mm, k); };
  const go = (sigs) => { n = 0; const r = attestationStands(decodeAttestation(encodeAttestation({ ...body, signatures: sigs })), { manifest: DM, roundIdBytes: R, verify: vs, drawn: pks }); return { ...r, n }; };
  const honest = go([0, 1, 2, 3, 4].map(sig)); assert.equal(honest.ok, true, honest.why);
  const pad = go([...[0, 1, 2, 3, 4, 5, 6].map(sig), sig(0), ...Array.from({ length: 5000 }, () => sig(0))]); assert.equal(pad.ok, false); assert.equal(pad.n, 0);
  // drawn handed as hex strings in upper case: the Set is lowercase, size still 7
  const hexDrawn = pks.map((k) => Buffer.from(k).toString('hex').toUpperCase());
  n = 0; const r2 = attestationStands(decodeAttestation(encodeAttestation({ ...body, signatures: [0, 1, 2, 3, 4].map(sig) })), { manifest: DM, roundIdBytes: R, verify: vs, drawn: hexDrawn });
  assert.equal(r2.ok, true, r2.why);
});
test('value attestation: 65,000 padded refused with 0 checks; honest 2 of 3 stands', () => {
  const SM = { ...M, outcomes: [...SCALAR_SIDES], scalar: { low: 1n, high: 10n, unit: 'u' }, requiredProtocolVersion: SCALAR_VERSION };
  const vb = { roundId: R, value: 5n, observedAtMs: 1791700000000n };
  const vs = (a) => ({ key: a.pub, signature: new Uint8Array(sign(null, Buffer.from(valueAttestationBodyId(vb)), a.key)) });
  calls = 0; const ok = valueAttestationStands(decodeValueAttestation(encodeValueAttestation({ ...vb, signatures: [vs(A[0]), vs(A[1])] })), { manifest: SM, roundIdBytes: R, verify: vEd });
  assert.equal(ok.ok, true, ok.why);
  calls = 0; const bad = valueAttestationStands(decodeValueAttestation(encodeValueAttestation({ ...vb, signatures: Array.from({ length: 65000 }, () => vs(A[0])) })), { manifest: SM, roundIdBytes: R, verify: vEd });
  assert.equal(bad.ok, false); assert.equal(calls, 0);
});
