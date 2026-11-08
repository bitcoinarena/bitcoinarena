// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1328 (§0A.7a RULED 2026-11-07, #1292): "a manifest may name a backup attestor set the seats consult after resolve_at + deadline/2 when the
// first set is silent". The set after marker 0x0b; its threshold more than half; an attestation it signs refused before then, taken after.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createPublicKey, sign, verify } from 'node:crypto';
import { encodeManifest, decodeManifest, manifestBodyId, RESULT_TYPE, PAYOUT_RULE, NO_PARENT, BACKUP_ATTESTORS_MARKER } from '../src/manifest.js';
import { encodeAttestation, decodeAttestation, attestationBodyId, attestationStands, backupOpensAtMs } from '../src/attested.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const verifyEd = (sig, msg, key) => verify(null, Buffer.from(msg), createPublicKey({ key: Buffer.concat([SPKI, Buffer.from(key)]), format: 'der', type: 'spki' }), Buffer.from(sig));
const kp = () => { const { privateKey, publicKey } = generateKeyPairSync('ed25519'); return { key: privateKey, pub: new Uint8Array(publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)) }; };
const sorted = (xs) => xs.sort((x, y) => Buffer.compare(Buffer.from(x.pub), Buffer.from(y.pub)));
const DEV = kp(), FIRST = sorted([kp(), kp(), kp()]), BACKUP = sorted([kp(), kp(), kp(), kp(), kp()]);
const TERMS = { nodeFeeBps: 40, donationBps: 60, question: 'Up or down?', resolveAfterCloseMs: 900000n, deadlineAfterResolveMs: 600000n, sourceRule: 'median' };
const BODY = { gameName: 'updown-backup', gameDevPubkey: DEV.pub, version: 1, parentManifestId: NO_PARENT, resultType: RESULT_TYPE.ATTESTED,
  cores: [], runTicksMax: 0, roundPeriodMs: 0n, payoutRule: PAYOUT_RULE.PARI_MUTUEL, rankNumerator: 0, rankDenominator: 0, minScore: 0,
  clients: [], gameDonationSetId: b32(0xd0), outcomes: ['up', 'down'], attestors: FIRST.map((a) => a.pub), attestThreshold: 2, marketTerms: TERMS };
const signed = (b) => ({ ...b, signature: new Uint8Array(sign(null, Buffer.from(manifestBodyId(b)), DEV.key)) });
const ROUND = b32(0x77);
const attest = (by, outcome = 0) => { const body = { roundId: ROUND, outcome, observedAtMs: 1n }; return decodeAttestation(encodeAttestation({ ...body,
  signatures: by.map((a) => ({ key: a.pub, signature: new Uint8Array(sign(null, Buffer.from(attestationBodyId(body)), a.key)) })) })); };

test('#1328 a backup attestor set: after its marker, more than half, consulted only from resolve + deadline/2', () => {
  const plain = encodeManifest(signed(BODY));
  const m = signed({ ...BODY, backupAttestors: { attestors: BACKUP.map((a) => a.pub), threshold: 3 } });
  const bytes = encodeManifest(m), back = decodeManifest(bytes);
  assert.deepEqual(encodeManifest(back), bytes);
  assert.equal(back.backupAttestors.threshold, 3);
  assert.equal(bytes.length - plain.length, 1 + 2 + 5 * 32 + 1);            // marker, count (u16), keys, threshold - nothing before it moves
  assert.ok(bytes.includes(BACKUP_ATTESTORS_MARKER));
  assert.throws(() => encodeManifest(signed({ ...BODY, backupAttestors: { attestors: BACKUP.map((a) => a.pub), threshold: 2 } })), /more than half of its attestors: 2 of 5/);
  assert.throws(() => encodeManifest(signed({ ...BODY, marketTerms: undefined, backupAttestors: { attestors: BACKUP.map((a) => a.pub), threshold: 3 } })), /names its terms/);
  const at = (open) => attestationStands(attest(BACKUP.slice(0, 3)), { manifest: back, roundIdBytes: ROUND, verify: verifyEd, backupOpen: open });
  const got = {
    opensAt: String(backupOpensAtMs({ entryCloseMs: 1000n, terms: TERMS })),
    firstSet: attestationStands(attest(FIRST.slice(0, 2)), { manifest: back, roundIdBytes: ROUND, verify: verifyEd }).ok,
    backupBefore: at(false).ok, backupAfter: at(true).ok,
    backupTwoOfFive: attestationStands(attest(BACKUP.slice(0, 2)), { manifest: back, roundIdBytes: ROUND, verify: verifyEd, backupOpen: true }).ok,
    mixed: attestationStands(attest([FIRST[0], BACKUP[0], BACKUP[1]]), { manifest: back, roundIdBytes: ROUND, verify: verifyEd, backupOpen: true }).ok,
  };
  console.log('  MEASURED #1328 backup:', JSON.stringify(got));
  assert.equal(got.opensAt, String(1000n + 900000n + 300000n));
  assert.deepEqual([got.firstSet, got.backupBefore, got.backupAfter, got.backupTwoOfFive, got.mixed], [true, false, true, false, false]);
  assert.match(at(false).why, /consulted only after/);
  assert.equal(at(true).backup, true);
});
