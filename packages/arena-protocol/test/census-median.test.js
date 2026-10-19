// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// SELF-BINDING SCALARS, A BOND-WEIGHTED MEDIAN (§27A.2): a node declares its bond_min and proposal deposit in its
// advertisement (17 bytes before serving; none declared keeps the bytes); the value in force is the median weighted by bond.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeAdvert, decodeAdvert, DECLARES_MARKER, NOT_SERVING_MARKER } from '../src/advert.js';
import { bondWeightedMedian } from '../src/census-median.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const ADVERT = { nodePubkey: b32(1), operatorId: 'op', protocolVersions: [1, 2, 3], roles: ['game', 'settlement'], endpoint: 'ws://n', region: 'eu',
  capacityClass: 1, softwareHash: b32(2), settlementCapabilities: 0, lightningCapabilities: 0, bondTxid: b32(3), bondVout: 0, bondScriptTemplateVersion: 1,
  payoutPubkey: b32(4), guardianOf: [], hostedGames: [], timestamp: 1790000000000n };
const D = { bondMinSats: 150000n, proposalDepositSats: 20000n };

test('declared scalars ride before serving; none declared keeps the bytes; every combination reads back', () => {
  const plain = encodeAdvert(ADVERT);
  const dec = encodeAdvert({ ...ADVERT, declares: D });
  assert.deepEqual(dec.subarray(0, plain.length), plain); assert.equal(dec[plain.length], DECLARES_MARKER); assert.equal(dec.length, plain.length + 17);
  assert.equal(decodeAdvert(plain).declares, undefined);
  assert.deepEqual(decodeAdvert(dec).declares, D);
  const both = decodeAdvert(encodeAdvert({ ...ADVERT, declares: D, serving: false }));
  assert.deepEqual(both.declares, D); assert.equal(both.serving, false);
  assert.equal(encodeAdvert({ ...ADVERT, declares: D, serving: false }).at(-1), NOT_SERVING_MARKER);
  assert.throws(() => decodeAdvert(Uint8Array.from([...plain, 0x01, 0x02])), /trailing bytes/);
});

test('the value in force is the bond-weighted median; an outlier moves nothing; a node declaring nothing does not count', () => {
  const e = (bondSats, bondMinSats) => ({ bondSats, advert: bondMinSats === null ? {} : { declares: { bondMinSats, proposalDepositSats: 0n } } });
  assert.equal(bondWeightedMedian([e(100n, 50000n), e(100n, 60000n), e(100n, 70000n)], 'bondMinSats'), 60000n);
  // the heavy bond decides where it reaches half the weight
  assert.equal(bondWeightedMedian([e(100n, 50000n), e(100n, 60000n), e(300n, 90000n)], 'bondMinSats'), 90000n);
  // an absurd declaration with little weight moves nothing
  assert.equal(bondWeightedMedian([e(100n, 50000n), e(100n, 60000n), e(100n, 70000n), e(1n, 10n ** 15n)], 'bondMinSats'), 60000n);
  assert.equal(bondWeightedMedian([e(100n, null), e(100n, 70000n)], 'bondMinSats'), 70000n);
  assert.equal(bondWeightedMedian([e(100n, null)], 'bondMinSats'), null);
  assert.throws(() => bondWeightedMedian([], 'nodeFeeBps'), /not a self-binding scalar/);
});
