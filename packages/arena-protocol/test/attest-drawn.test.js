// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A GAME WHOSE ATTESTORS ARE DRAWN PER ROUND (kanban #630, protocol 21): the manifest names { count 7, threshold 5 } and no keys;
// an outcome stands with 5 of the round's 7 drawn attestors, never with 4, never with a key the round did not draw.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createPublicKey, sign, verify } from 'node:crypto';
import { encodeManifest, decodeManifest, manifestBodyId, isDrawnAttest, RESULT_TYPE, PAYOUT_RULE, NO_PARENT } from '../src/manifest.js';
import { encodeAttestation, decodeAttestation, attestationBodyId, attestationStands } from '../src/attested.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');
const verifyEd25519 = (sig, msg, key) => verify(null, Buffer.from(msg),
  createPublicKey({ key: Buffer.concat([SPKI_ED25519, Buffer.from(key)]), format: 'der', type: 'spki' }), Buffer.from(sig));
const keyPair = () => { const { privateKey, publicKey } = generateKeyPairSync('ed25519'); return { key: privateKey, pub: new Uint8Array(publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)) }; };
const DEV = keyPair();
const BODY = {
  gameName: 'up-down-drawn', gameDevPubkey: DEV.pub, version: 1, parentManifestId: NO_PARENT, resultType: RESULT_TYPE.ATTESTED,
  cores: [], runTicksMax: 0, roundPeriodMs: 0n, payoutRule: PAYOUT_RULE.PARI_MUTUEL, rankNumerator: 0, rankDenominator: 0, minScore: 0,
  clients: [], gameDonationSetId: b32(0xd0), outcomes: ['Up', 'Down'], attestors: [], attestThreshold: 0,
  attestDraw: { count: 7, threshold: 5 }, requiredProtocolVersion: 21,
};
const MARKET = { ...BODY, signature: new Uint8Array(sign(null, Buffer.from(manifestBodyId(BODY)), DEV.key)) };
const ROUND = b32(0x77);
const DRAWN = Array.from({ length: 7 }, keyPair);
const attest = (by) => { const body = { roundId: ROUND, outcome: 1, observedAtMs: 1000n };
  return decodeAttestation(encodeAttestation({ ...body, signatures: by.map((a) => ({ key: a.pub, signature: new Uint8Array(sign(null, Buffer.from(attestationBodyId(body)), a.key)) })) })); };
const stands = (a, drawn = DRAWN.map((d) => d.pub)) => attestationStands(a, { manifest: MARKET, roundIdBytes: ROUND, verify: verifyEd25519, drawn });

test('the draw is in the manifest\'s bytes, read back the same; fixed keys alongside it are refused', () => {
  const back = decodeManifest(encodeManifest(MARKET));
  assert.deepEqual(back.attestDraw, { count: 7, threshold: 5 });
  assert.ok(isDrawnAttest(back));
  assert.deepEqual(encodeManifest(back), encodeManifest(MARKET));
  assert.throws(() => manifestBodyId({ ...BODY, attestors: [DEV.pub], attestThreshold: 1 }), /names no attestor keys/);
  assert.throws(() => manifestBodyId({ ...BODY, attestDraw: { count: 3, threshold: 2 } }), /7 of the round's nodes/);
  assert.throws(() => manifestBodyId({ ...BODY, requiredProtocolVersion: 20 }), /requires protocol version/);
});

test('5 of the round\'s 7 drawn attestors stand; 4 do not; a key the round did not draw is refused by name; no draw given, no standing', () => {
  const five = stands(attest(DRAWN.slice(0, 5)));
  assert.equal(five.ok, true, five.why);
  assert.match(five.why, /signed by 5 of 7 attestors \(threshold 5\)/);
  const four = stands(attest(DRAWN.slice(2, 6)));
  assert.equal(four.ok, false);
  assert.match(four.why, /4 attestor signature\(s\).*asks 5 of its 7/);
  const stranger = stands(attest([...DRAWN.slice(0, 4), keyPair()]));
  assert.match(stranger.why, /this round did not draw as an attestor/);
  assert.match(stands(attest(DRAWN.slice(0, 5)), null).why, /drawn attestors were not given/);
});
