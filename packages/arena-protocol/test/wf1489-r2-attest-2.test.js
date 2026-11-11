// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 round 2 (attestations): ONE PUBLIC ATTESTATION, PADDED, STALLS A SEAT FOR SECONDS PER REQUEST.
// POST /outcome (server.js holdOutcome) is open to anybody and runs attestationStands BEFORE anything else is asked (timely, held, terminal).
// attestationStands (and scalar.js valueAttestationStands) verifies EVERY signature the body carries, a key it has seen verify already too
// (`signed` is a Set, but nothing skips a key already in it). The wire's list is a u16 vec - up to 65,535 signatures - and the door reads up
// to 8 MB. So anybody who copies a held attestation (GET /outcome serves its bytes) and repeats one of its good signatures 65,000 times
// makes the seat run 65,000 signature checks on its one thread for one request (Ed25519 for fixed attestors; BIP-340 in JS for drawn ones),
// for any round, at any time - the timely check comes after it.
// SAFE: a key's signature is checked once (a repeat is skipped or refused), or a list longer than the attestor set is refused before any check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createPublicKey, sign, verify } from 'node:crypto';
import { manifestBodyId, RESULT_TYPE, PAYOUT_RULE, NO_PARENT } from '../src/manifest.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { encodeAttestation, decodeAttestation, attestationBodyId, attestationStands } from '../src/attested.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');
let calls = 0;
const verifyEd25519 = (sig, msg, key) => { calls++; return verify(null, Buffer.from(msg),
  createPublicKey({ key: Buffer.concat([SPKI_ED25519, Buffer.from(key)]), format: 'der', type: 'spki' }), Buffer.from(sig)); };
const keyPair = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { key: privateKey, pub: new Uint8Array(publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)) };
};
const DEV = keyPair();
const ATTESTORS = [keyPair(), keyPair(), keyPair()].sort((x, y) => Buffer.compare(Buffer.from(x.pub), Buffer.from(y.pub)));
const BODY = {
  gameName: 'btc-close', gameDevPubkey: DEV.pub, version: 1, parentManifestId: NO_PARENT, resultType: RESULT_TYPE.ATTESTED,
  cores: [], runTicksMax: 0, roundPeriodMs: 0n, payoutRule: PAYOUT_RULE.PARI_MUTUEL, rankNumerator: 0, rankDenominator: 0, minScore: 0,
  clients: [], gameDonationSetId: b32(0xd0), outcomes: ['above 100k', 'between', 'below 90k'], attestors: ATTESTORS.map((a) => a.pub), attestThreshold: 2,
};
const MARKET = { ...BODY, signature: new Uint8Array(sign(null, Buffer.from(manifestBodyId(BODY)), DEV.key)) };
const ROUND = b32(0x77);

test('wf1489-r2-attest-2: an attestation carrying one good signature 65,000 times is not verified 65,000 times', () => {
  const body = { roundId: ROUND, outcome: 0, observedAtMs: 1791700000000n };
  const sig = (a) => ({ key: a.pub, signature: new Uint8Array(sign(null, Buffer.from(attestationBodyId(body)), a.key)) });
  const honest = { ...body, signatures: [sig(ATTESTORS[0]), sig(ATTESTORS[1])] };
  // the attacker: the held attestation's bytes (public), its first signature repeated
  const padded = { ...body, signatures: [...honest.signatures, ...Array.from({ length: 65000 }, () => honest.signatures[0])] };
  const bytes = encodeAttestation(padded);
  const a = decodeAttestation(bytes);
  calls = 0;
  const t0 = process.hrtime.bigint();
  const got = attestationStands(a, { manifest: MARKET, roundIdBytes: ROUND, verify: verifyEd25519 });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log('  MEASURED:', JSON.stringify({ bodyBytes: bytes.length, under8MB: bytes.length < 8 * 1024 * 1024, signatures: a.signatures.length, stands: got.ok, verifyCalls: calls, blockedMs: Math.round(ms) }));
  // a DRAWN game's attestation is checked with BIP-340 in JS (server.js drawnAttestCheck: schnorr.verify): the same 65,002 checks at its cost
  const sk = b32(9), pk = schnorr.getPublicKey(sk), m = attestationBodyId(body), ss = schnorr.sign(m, sk);
  const t1 = process.hrtime.bigint(); for (let i = 0; i < 500; i++) schnorr.verify(ss, m, pk);
  const per = Number(process.hrtime.bigint() - t1) / 1e6 / 500;
  console.log('  MEASURED drawn:', JSON.stringify({ schnorrVerifyMs: Number(per.toFixed(3)), projectedBlockedMsFor65002: Math.round(per * 65002) }));
  assert.ok(calls <= ATTESTORS.length, `one POST /outcome made ${calls} signature checks (${Math.round(ms)} ms on the seat's one thread) for ${ATTESTORS.length} attestors`);
});
