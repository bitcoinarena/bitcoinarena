// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A GATEWAY CLAIM'S PEG-IN OUTPOINTS (spec §23A.3a "What counts as the peg-in", kanban #559/#543): signed with the rest when the claim names
// any; a claim that names none hashes as before (the claims already out keep their signatures); a changed list fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { signGatewayClaim, checkGatewayClaim, gatewayClaimHash } from '../src/gateway-claim.js';
import { toHex } from '../src/hash.js';

const secret = new Uint8Array(32).fill(5), node = toHex(schnorr.getPublicKey(secret));
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const fields = { node, federationId: 'f0'.repeat(32), gatewayUrl: 'https://gw.example/gateway/', lightningPubkey: '02' + 'ab'.repeat(32), capacitySats: 300000,
  pegInSats: 55000, atMs: Date.parse('2026-10-20T16:00:00Z'), inboundSats: 150000, outboundSats: 150000, outsideInboundSats: 150000 };
const A = 'f3394aa835525163e306a948d136afb7446977f26a4f347ecbc20faad97988cf:1', B = 'c35cf68fc9a922bf5d922b2c1cdcdf0d10b068a6ff7496940caec67780ae2266:1';

test('no outpoints: the same hash as a claim before them; outpoints signed, sorted and once each; a changed list fails', () => {
  const plain = signGatewayClaim(fields, (h) => schnorr.sign(h, secret));
  assert.equal(plain.pegInOutpoints, undefined);
  assert.deepEqual(checkGatewayClaim(plain, verify), { ok: true });
  const withOuts = signGatewayClaim({ ...fields, pegInOutpoints: [B, A.toUpperCase(), A] }, (h) => schnorr.sign(h, secret));
  assert.deepEqual(withOuts.pegInOutpoints, [B, A].map((x) => x.toLowerCase()).sort());
  assert.deepEqual(checkGatewayClaim(withOuts, verify), { ok: true });
  assert.notEqual(toHex(gatewayClaimHash(withOuts)), toHex(gatewayClaimHash(plain)), 'the outpoints are under the signature');
  assert.equal(checkGatewayClaim({ ...withOuts, pegInOutpoints: [A] }, verify).ok, false, 'one outpoint dropped: the signature fails');
  assert.match(checkGatewayClaim({ ...withOuts, pegInOutpoints: ['nope'] }, verify).why, /txid:vout/);
});
