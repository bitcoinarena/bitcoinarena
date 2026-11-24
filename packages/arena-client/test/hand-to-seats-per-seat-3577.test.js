// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3577: a paid record is kept by two SEATS. Two seats behind one host (as live) that each prove a census key keep it; the same two
// addresses proving nothing are one seat; a seat whose addresses disagree (one 200, one refusal) does not count as keeping it.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { handToSeats } from '../src/item-buy.js';
import { identityProofDigest, forgetProofs } from '../src/seat-identity.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const secrets = [0x41, 0x42].map((n) => new Uint8Array(32).fill(n));
const census = secrets.map((s) => toHex(schnorr.getPublicKey(s)));
const verify = (sig, msg, k) => schnorr.verify(sig, msg, k);
const seats = ['https://seats.example/guardian-1', 'https://seats.example/guardian-2'];
const fetchWith = (refuse = []) => async (url) => {
  if (url.includes('/identity?nonce=')) {
    const i = seats.findIndex((s) => url.startsWith(s + '/'));
    const nonce = fromHex(new URL(url).searchParams.get('nonce'));
    return Response.json({ node: census[i], sig: toHex(schnorr.sign(identityProofDigest(nonce), secrets[i])) });
  }
  return refuse.some((r) => url.startsWith(r)) ? new Response('busy', { status: 503 }) : new Response('', { status: 200 });
};
beforeEach(() => forgetProofs());

test('two seats on one host proving census keys keep the record', async () => {
  const got = await handToSeats({ seats, door: 'item-purchase', body: '{}', fetch: fetchWith(), keys: census, verify });
  assert.equal(got.keptBy, seats[0]);
  assert.equal(got.kept, 2);
});

test('the same addresses proving nothing are one seat, and one seat of two keeps nothing', async () => {
  const got = await handToSeats({ seats: [...seats, 'https://other.example'], door: 'item-purchase', body: '{}', fetch: fetchWith(['https://other.example']), verify });
  assert.equal(got.keptBy, null);
  assert.equal(got.kept, 1);
});

test('a seat whose addresses disagree does not keep it', async () => {
  const got = await handToSeats({ seats: ['https://one.example/a', 'https://one.example/b', 'https://two.example'], door: 'item-purchase', body: '{}',
    fetch: fetchWith(['https://one.example/b']), verify });
  assert.equal(got.keptBy, null);
});
