// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AUDIT nostr a7-1-1 (P5, P6): the owner doors' replay map (owner.js createOwner `used`) is filled by ANY key. check() keeps every
// well-signed request's sig (or its NIP-98 kind 27235 event id) BEFORE authorize() compares the key with the owner's, so a stranger who
// signs requests with his own key (POST /owner/<any action> is public) grows `used` without bound for the 2-minute window (4 min kept),
// and every later owner request - and every replay of one stranger request, which is answered before any signature check - walks the
// whole map first (`for (const [s, t] of used)`). SAFE: a request from a key that is not the owner's leaves nothing behind, and the cost
// of a request does not grow with what strangers sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { createOwner, ownerSecretFromSeed, signOwnerRequest } from '../src/owner.js';

const sign = (m, s) => schnorr.sign(m, s);
const pubkeyOf = (s) => schnorr.getPublicKey(s);
const verify = (sig, msg, key) => schnorr.verify(sig, msg, key);
const NODE = 'ab'.repeat(32);

test('a stranger\'s signed owner requests leave nothing behind and do not slow the owner door', () => {
  let now = 1_000_000;
  const m = { owner: null, code: null };
  const store = { read: () => m.owner, write: (o) => { m.owner = o; }, writeCode: (c) => { m.code = c; } };
  const o = createOwner({ store, verify, node: NODE, nowMs: () => now });
  const ownerSecret = ownerSecretFromSeed(new Uint8Array(32).fill(7));
  const strangerSecret = ownerSecretFromSeed(new Uint8Array(32).fill(9));
  const req = (secret, action, args = {}, atMs = now) => signOwnerRequest({ node: NODE, action, args, atMs, secret, sign, pubkeyOf });
  assert.ok(o.claim(req(ownerSecret, 'claim', { code: m.code })).ok, 'the owner claims');

  // the stranger: one request, refused as not the owner's
  const first = req(strangerSecret, 'leave', { n: 0 });
  assert.equal(o.authorize(first, 'leave').status, 403);
  // SAFE: the same request again is refused for the same reason (nothing of it was kept)
  const again = o.authorize(first, 'leave');
  assert.equal(again.status, 403, `a stranger's request was kept in the owner replay map: re-sent it answers ${again.status} '${again.why}'`);
});

test('the owner door\'s cost does not grow with the strangers\' requests in the window', () => {
  let now = 2_000_000;
  const m = { owner: null, code: null };
  const store = { read: () => m.owner, write: (o) => { m.owner = o; }, writeCode: (c) => { m.code = c; } };
  const o = createOwner({ store, verify, node: NODE, nowMs: () => now });
  const ownerSecret = ownerSecretFromSeed(new Uint8Array(32).fill(7));
  const strangerSecret = ownerSecretFromSeed(new Uint8Array(32).fill(9));
  const req = (secret, action, args = {}, atMs = now) => signOwnerRequest({ node: NODE, action, args, atMs, secret, sign, pubkeyOf });
  assert.ok(o.claim(req(ownerSecret, 'claim', { code: m.code })).ok);
  const probe = req(strangerSecret, 'stay', { probe: 1 });
  o.authorize(probe, 'stay');
  const cost = (k) => { const t0 = process.hrtime.bigint(); for (let i = 0; i < k; i++) o.authorize(probe, 'stay'); return Number(process.hrtime.bigint() - t0) / k / 1e3; };
  cost(200);
  const small = cost(2000);
  // one stranger key, 15,000 signed requests (any action, any args): each one is checked and refused 403, and each one is kept
  for (let i = 0; i < 15000; i++) o.authorize(req(strangerSecret, 'leave', { n: i }), 'leave');
  const big = cost(2000);
  console.log(`a re-sent request: ${small.toFixed(2)} us with 1 stranger request kept, ${big.toFixed(2)} us after 15,000 (x${(big / small).toFixed(1)})`);
  assert.ok(big < small * 5 + 5, `one request at the owner door costs ${big.toFixed(1)} us after one stranger's 15,000 signed requests, ${small.toFixed(1)} us before: the replay map walk grows with what strangers sent`);
});
