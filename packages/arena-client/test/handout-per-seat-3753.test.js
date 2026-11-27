// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A HANDOUT IS TAKEN BY SEATS, NOT URLS (kanban #3753, the gap in #3694): postHandout groups the link's URLs as seat-identity.js seatsOf does -
// one host one seat unless each URL proves a distinct key of the handout's signer nodes - and counts a seat once.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { postHandout } from '../src/join.js';
import { identityProofDigest, forgetProofs } from '../src/seat-identity.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const secrets = [b32(0x41), b32(0x42), b32(0x43)];
const keys = secrets.map((s) => schnorr.getPublicKey(s));
const verify = (sig, msg, key) => schnorr.verify(sig, msg, key);
const seats = ['https://seats.example/guardian-1', 'https://seats.example/guardian-2', 'https://seats.example/guardian-3'];
const box = ['https://box.example/s0', 'https://box.example/s1'];
const stake = { body: new Uint8Array([1, 2, 3]), handout: { needed: 2 } };
const proof = (i, u) => Response.json({ node: toHex(keys[i]), sig: toHex(schnorr.sign(identityProofDigest(fromHex(new URL(u).searchParams.get('nonce'))), secrets[i])) });
const fetcherOf = ({ full = false, relay = false } = {}) => async (u) => {
  const i = seats.findIndex((s) => u.startsWith(s + '/'));
  const b = box.findIndex((s) => u.startsWith(s + '/'));
  if (u.includes('/identity')) return i >= 0 ? proof(i, u) : b >= 0 && relay ? proof(b, u) : new Response('no', { status: 404 });
  if (b >= 0) return new Response('taken', { status: 201, headers: { 'x-entry-close-in-ms': '3600000' } });
  return full ? new Response('handout refused: that table is full', { status: 409 }) : new Response('taken', { status: 201, headers: { 'x-entry-close-in-ms': String(60000 + i) } });
};
beforeEach(() => forgetProofs());

test('two paths of one box are one seat: they do not take a handout the round\'s seats refuse', async () => {
  const put = await postHandout(stake, [...seats, ...box], { fetcher: fetcherOf({ full: true }), keys, verify });
  assert.equal(put.ok, false);
  assert.equal(put.accepted, 1);
  // and on an open table the seats and the box are four seats; the close is one per seat, the needed-th latest
  forgetProofs();
  const open = await postHandout(stake, [...seats, ...box], { fetcher: fetcherOf(), keys, verify });
  assert.equal(open.ok, true);
  assert.equal(open.accepted, 4);
});

test('the live layout (seats behind one host proving the handout\'s keys) stays several seats', async () => {
  const put = await postHandout(stake, seats, { fetcher: fetcherOf(), keys, verify });
  assert.equal(put.ok, true);
  assert.equal(put.accepted, 3);
});

test('a box relaying the seats\' identity proofs is one seat with each seat it relays: their refusal stands', async () => {
  const put = await postHandout(stake, [...seats.slice(0, 2), ...box], { fetcher: fetcherOf({ full: true, relay: true }), keys, verify });
  assert.equal(put.ok, false);
  assert.equal(put.accepted, 0);
});

test('a host whose URLs prove no key of the handout is one seat, and its URLs post the handout all the same', async () => {
  const asked = [];
  const f = fetcherOf();
  const put = await postHandout(stake, box, { fetcher: async (u, o) => { if (u.endsWith('/handout')) asked.push(u); return f(u, o); }, keys, verify });
  assert.equal(put.ok, false);
  assert.equal(put.accepted, 1);
  assert.equal(asked.length, 2);
  // with no curve to check a proof by, each URL counts, as before #3753
  const bare = await postHandout(stake, box, { fetcher: f, keys, verify: null });
  assert.equal(bare.accepted, 2);
});
