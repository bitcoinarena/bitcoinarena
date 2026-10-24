// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE PAGE CHECKS A DRAWN MARKET'S OUTCOME ITSELF (kanban #630): against the round's 7 drawn node keys it derived from the census, BIP-340,
// 5 of 7 - and without those 7 it shows the outcome unverified, never on a seat's word.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { checkAttestation } from '../src/market.js';
import { encodeAttestation, attestationBodyId } from '../../arena-protocol/src/attested.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const ROUND = new Uint8Array(32).fill(0x42);
const secretOf = (i) => { const s = new Uint8Array(32); s[31] = i + 3; return s; };
const DRAWN = Array.from({ length: 7 }, (_, i) => schnorr.getPublicKey(secretOf(i)));
const market = { name: 'up-down-drawn', outcomes: ['Up', 'Down'], attestors: [], threshold: 0, attestDraw: { count: 7, threshold: 5 } };
const body = { roundId: ROUND, outcome: 1, observedAtMs: 1800000n };
const signedBy = (ids) => toHex(encodeAttestation({ ...body, signatures: ids.map((i) => ({ key: DRAWN[i], signature: schnorr.sign(attestationBodyId(body), secretOf(i)) })) }));
const verifySchnorr = async (sg, m, k) => { try { return schnorr.verify(sg, m, k); } catch { return false; } };

test('a drawn market\'s outcome: 5 of the round\'s 7 verify it, 4 do not, no derived draw leaves it unverified', async () => {
  const five = await checkAttestation({ attestationHex: signedBy([0, 1, 2, 3, 4]), market, roundIdHex: toHex(ROUND), drawn: DRAWN, verifySchnorr });
  assert.deepEqual([five.verified, five.label], [true, 'Down'], five.why);
  const four = await checkAttestation({ attestationHex: signedBy([0, 1, 2, 3]), market, roundIdHex: toHex(ROUND), drawn: DRAWN, verifySchnorr });
  assert.equal(four.verified, false);
  const none = await checkAttestation({ attestationHex: signedBy([0, 1, 2, 3, 4]), market, roundIdHex: toHex(ROUND) });
  assert.deepEqual([none.verified, none.unverifiable], [false, true]);
  console.log('  PAGE:', five.why, '|', four.why, '|', none.why);
});
