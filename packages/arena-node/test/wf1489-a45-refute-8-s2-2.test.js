// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 a45 refute 8, skeptic 2 (fix #2270 8dcae9501): the named-height token bucket (NAMED_CENSUS_BURST 8, 4 a minute) is one
// bucket for the whole door, shared by strangers and the federation's own gatherer. GET /federation-record needs no key and the
// federation id is public, so a stranger spends the 8 tokens on heights near the tip (and 4 a minute keeps it empty). The honest gatherer's
// named height (the kanban #549 case: right after a restart a guardian seat has not read it yet) is then refused - "this seat holds no
// round with census height n" - the very bug #549 fixed. At e3d58f185 (before #2270) the honest ask is read and signed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { federationRecords } from '../src/federation-records.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const NET = new Uint8Array(32).fill(0x10);

test('a stranger spending the named-height reads first does not make the guardian seat refuse its gatherer\'s height (kanban #549)', async () => {
  const SUCC = new Uint8Array(32).fill(0x4e);
  const n = { secret: new Uint8Array(32).fill(71) }; n.pubkey = schnorr.getPublicKey(n.secret);
  const entry = { pubkey: n.pubkey, txid: new Uint8Array(32).fill(0xe1), vout: 0, bondSats: 50000n,
    advert: { operatorId: 'op549b', endpoint: 'wss://n549b.example', guardianEndpoint: 'wss://g549b.example', guardianOf: [{ federationId: SUCC, guardianKey: Uint8Array.from([2, ...new Uint8Array(32).fill(0x91)]) }] } };
  let now = 1_000_000;
  const seat = federationRecords({ round: { pubkey: n.pubkey, identity: { secret: n.secret } }, newest: () => null, roster: { censusFor: () => ({ ok: false }) },
    inviteFor: (fid) => (fid === toHex(SUCC) ? `fed:${fid}` : null), networkId: NET, nowMs: () => now, censusAt: async () => [entry], chainTip: async () => 157092 });
  // the stranger: the public federation id, eight heights near the tip, no key
  for (let i = 0; i < 8; i++) await seat.mySignature(toHex(SUCC), 157000 + i);
  now += 10_000;
  const honest = await seat.mySignature(toHex(SUCC), 157086);
  console.log(`honest gatherer after a stranger's 8 asks: ${honest.ok ? `signed at ${honest.height}` : honest.why}`);
  assert.deepEqual([honest.ok, honest.height], [true, 157086], honest.why);
});
