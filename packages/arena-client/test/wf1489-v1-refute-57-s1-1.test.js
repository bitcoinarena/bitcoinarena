// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1546 refute (wf1489 v1 #57): the seat now refuses a signature list longer than the attestor set before any check, but the
// PAGE's copy of the check (arena-client market.js checkAttestation and checkMarketOutcome's value branch) pre-verifies EVERY signature
// the seat's GET /outcome bytes carry into a `said` map BEFORE it calls attestationStands - so one hostile seat answering GET /outcome
// with a held attestation padded to 65,000 repeats makes the player's browser run 65,000 signature checks (BIP-340 in JS for a drawn
// market, ~0.6 ms each: ~40 s on the page's thread). SAFE: the page checks at most one signature per attestor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, verify as edVerify, createPublicKey } from 'node:crypto';
import { checkAttestation, checkMarketOutcome } from '../src/market.js';
import { encodeAttestation, attestationBodyId } from '../../arena-protocol/src/attested.js';
import { encodeValueAttestation, valueAttestationBodyId } from '../../arena-protocol/src/scalar.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { RESULT_TYPE } from '../../arena-protocol/src/manifest.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const edKey = () => { const { privateKey, publicKey } = generateKeyPairSync('ed25519'); return { key: privateKey, pub: new Uint8Array(publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)) }; };
let calls = 0;
const verifyEd = async (sig, digest, key) => { calls++; return edVerify(null, Buffer.from(digest), createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(key)]), format: 'der', type: 'spki' }), Buffer.from(sig)); };
const ATT = [edKey(), edKey(), edKey()];
const ROUND = b32(0x77);
const PAD = 65000;

test('wf1489-v1-refute-57-s1-1: a hostile seat\'s padded outcome attestation is not verified 65,000 times by the page', async () => {
  const body = { roundId: ROUND, outcome: 0, observedAtMs: 1791700000000n };
  const s = (a) => ({ key: a.pub, signature: new Uint8Array(sign(null, Buffer.from(attestationBodyId(body)), a.key)) });
  const honest = [s(ATT[0]), s(ATT[1])];
  const hex = toHex(encodeAttestation({ ...body, signatures: [...honest, ...Array.from({ length: PAD }, () => honest[0])] }));
  const market = { name: 'btc-close', outcomes: ['up', 'down'], attestors: ATT.map((a) => toHex(a.pub)), threshold: 2 };
  calls = 0; const t0 = Date.now();
  const got = await checkAttestation({ attestationHex: hex, market, roundIdHex: toHex(ROUND), verify: verifyEd });
  console.log('  MEASURED outcome:', JSON.stringify({ verified: got.verified, verifyCalls: calls, ms: Date.now() - t0, why: got.why.slice(0, 90) }));
  assert.ok(calls <= ATT.length, `the page ran ${calls} signature checks for one GET /outcome answer of ${ATT.length} attestors (${Date.now() - t0} ms)`);
});

test('wf1489-v1-refute-57-s1-1: a hostile seat\'s padded VALUE attestation is not verified 65,000 times by the page', async () => {
  const body = { roundId: ROUND, value: 8300000n, observedAtMs: 1791700000000n };
  const s = (a) => ({ key: a.pub, signature: new Uint8Array(sign(null, Buffer.from(valueAttestationBodyId(body)), a.key)) });
  const honest = [s(ATT[0]), s(ATT[1])];
  const hex = toHex(encodeValueAttestation({ ...body, signatures: [...honest, ...Array.from({ length: PAD }, () => honest[0])] }));
  const market = { name: 'btc-at-18', outcomes: ['LONG', 'SHORT'], attestors: ATT.map((a) => toHex(a.pub)), threshold: 2,
    scalar: { low: 8000000n, high: 9000000n, unit: 'USD cents' },
    manifest: { gameName: 'btc-at-18', resultType: RESULT_TYPE.ATTESTED, outcomes: ['LONG', 'SHORT'], attestors: ATT.map((a) => a.pub), attestThreshold: 2 } };
  calls = 0; const t0 = Date.now();
  const got = await checkMarketOutcome({ outcome: { attestation: hex }, market, roundIdHex: toHex(ROUND), verify: verifyEd });
  console.log('  MEASURED value:', JSON.stringify({ verified: got.verified, verifyCalls: calls, ms: Date.now() - t0, why: String(got.why).slice(0, 90) }));
  assert.ok(calls <= ATT.length, `the page ran ${calls} signature checks for one GET /outcome value answer of ${ATT.length} attestors (${Date.now() - t0} ms)`);
});
