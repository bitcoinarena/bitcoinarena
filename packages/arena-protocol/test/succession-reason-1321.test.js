// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1321 (§23A.6 RULED 2026-11-07, #1309): "A guardian-called succession names its reason (a federation_nominal change or a listed
// upgrade) or pays no drain shares." The reason is a field of the DRAINING record, after the player reserve; a DRAINING record whose seated
// guardians alone would read OPEN is guardian-called.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fr from '../src/federation-record.js';

const { encodeFederationRecord, decodeFederationRecord, FEDERATION_STATUS, thresholdOf, guardianCalled, paysDrainShares, SUCCESSION_REASON, CAPACITY_BAND } = fr;
const guardian = (i) => ({ peerKey: Uint8Array.from([2, ...new Uint8Array(32).fill(i)]), nodePubkey: new Uint8Array(32).fill(i), operatorId: `op${i}`, bondTxid: new Uint8Array(32).fill(0x40 + i), bondVout: 0, endpoint: '' });
const record = (over = {}) => ({
  federationId: new Uint8Array(32).fill(0xf1), networkId: new Uint8Array(32).fill(0x0e), invite: 'fed1x', nominal: 7, threshold: thresholdOf(7),
  guardians: [1, 2, 3, 4, 5, 6, 7].map(guardian), status: FEDERATION_STATUS.DRAINING, successorId: new Uint8Array(32).fill(0xcd), gone: [],
  exposureCapSats: 1_000_000n, reserveSats: 400_000n, height: 900, capacityBand: Object.keys(CAPACITY_BAND)[0],
  gatewayFeeMax: { ppm: 1000, baseMsat: 10000 }, playerReserveSats: 300_000n, ...over });

test('#1321 the reason round-trips after the player reserve; a record without it keeps its bytes', () => {
  const ref = new Uint8Array(32).fill(0xab);
  const withReason = record({ successionReason: { kind: 'LISTED_UPGRADE', ref } });
  const back = decodeFederationRecord(encodeFederationRecord(withReason));
  assert.equal(back.successionReason.kind, 'LISTED_UPGRADE');
  assert.deepEqual([...back.successionReason.ref], [...ref]);
  assert.equal(back.playerReserveSats, 300_000n);
  const plain = record();
  assert.equal(encodeFederationRecord(withReason).length, encodeFederationRecord(plain).length + 33);
  assert.equal(decodeFederationRecord(encodeFederationRecord(plain)).successionReason, undefined);
  assert.equal(decodeFederationRecord(encodeFederationRecord(record({ successionReason: { kind: 'NOMINAL_CHANGE' } }))).successionReason.kind, 'NOMINAL_CHANGE');
});

test('#1321 a reason is named only by a DRAINING record naming its successor, after the player reserve, and only of the two kinds', () => {
  assert.throws(() => encodeFederationRecord(record({ status: FEDERATION_STATUS.OPEN, successionReason: { kind: 'NOMINAL_CHANGE' } })), /DRAINING record/);
  assert.throws(() => encodeFederationRecord(record({ successorId: new Uint8Array(32), successionReason: { kind: 'NOMINAL_CHANGE' } })), /names its successor/);
  assert.throws(() => encodeFederationRecord(record({ playerReserveSats: null, successionReason: { kind: 'NOMINAL_CHANGE' } })), /follows the player reserve/);
  assert.throws(() => encodeFederationRecord(record({ successionReason: { kind: 'BORED' } })), /one of NOMINAL_CHANGE, LISTED_UPGRADE/);
  assert.deepEqual(Object.keys(SUCCESSION_REASON), ['NOMINAL_CHANGE', 'LISTED_UPGRADE']);
});

test('#1321 guardian-called: DRAINING with every guardian seated - no reason, no drain shares; a forced drain pays as before', () => {
  assert.equal(guardianCalled(record()), true);
  assert.equal(paysDrainShares(record()), false, 'a guardian-called succession with no reason pays drain shares');
  assert.equal(paysDrainShares(record({ successionReason: { kind: 'NOMINAL_CHANGE' } })), true);
  // one of seven gone: seated 6 reads DRAINING by itself (trigger 1) - forced, it pays
  const one = record({ gone: [{ peerKey: guardian(3).peerKey, sinceHeight: 800, kind: 1, proofRef: new Uint8Array(32) }] });
  assert.equal(guardianCalled(one), false);
  assert.equal(paysDrainShares(one), true);
  // CRITICAL and OPEN are never guardian-called
  assert.equal(guardianCalled(record({ status: FEDERATION_STATUS.CRITICAL })), false);
  assert.equal(guardianCalled(record({ status: FEDERATION_STATUS.OPEN })), false);
});
