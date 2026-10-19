// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE GATEWAY SEATING SIGNED BY THE GUARDIANS (spec §23A.9): it stands with the threshold of seated guardians on the same seats for the
// same epoch; a guardian that ranked differently only fails to add its signature; strangers and forgeries count for nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { signGatewaySeating, standingSeating } from '../src/gateway-seating.js';
import { toHex } from '../src/hash.js';

const g = [1, 2, 3, 4, 5].map((n) => { const secret = new Uint8Array(32).fill(n); return { secret, hex: toHex(schnorr.getPublicKey(secret)) }; });
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const fid = 'f1'.repeat(32), A = 'aa'.repeat(32), B = 'bb'.repeat(32), C = 'cc'.repeat(32);
const sign = (i, seats, epoch = 7) => signGatewaySeating({ federationId: fid, epoch, seats }, g[i].hex, (h) => schnorr.sign(h, g[i].secret));
const seated = g.slice(0, 4).map((x) => x.hex);

test('three of four seated guardians on the same seats: it stands; the fourth ranked otherwise and only lacks its signature', () => {
  const r = standingSeating({ signed: [sign(0, [A, B]), sign(1, [B, A]), sign(2, [A, B]), sign(3, [A, C])], federationId: fid, epoch: 7, seated, threshold: 3, verify });
  assert.deepEqual([r.ok, r.seating.seats, r.signers], [true, [A, B], 3]);
});

test('below the threshold, another epoch, a stranger or a forgery: no seating', () => {
  assert.equal(standingSeating({ signed: [sign(0, [A, B]), sign(1, [A, B]), sign(2, [A, C])], federationId: fid, epoch: 7, seated, threshold: 3, verify }).ok, false);
  assert.equal(standingSeating({ signed: [sign(0, [A], 6), sign(1, [A], 6), sign(2, [A], 6)], federationId: fid, epoch: 7, seated, threshold: 3, verify }).ok, false, 'epoch 6 signatures');
  assert.equal(standingSeating({ signed: [sign(0, [A]), sign(1, [A]), sign(4, [A])], federationId: fid, epoch: 7, seated, threshold: 3, verify }).ok, false, 'guardian 5 is not seated');
  const forged = { ...sign(2, [A]), seats: [B] };
  const r = standingSeating({ signed: [sign(0, [B]), sign(1, [B]), forged], federationId: fid, epoch: 7, seated, threshold: 3, verify });
  assert.match(r.why, /at most 2/);
});
