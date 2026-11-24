// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3588: GET /gateway-seats answers count one per seat. Guardian seats behind one host (/guardian-1, /guardian-2, as live) that each
// prove a key of the checked census are two seats and seat their gateway; without the keys that host is one seat and seats nothing alone.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import * as pl from '../src/page-lock.js';
import { identityProofDigest, forgetProofs } from '../src/seat-identity.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const FID = 'b2'.repeat(32);
const GW = 'https://gw-a.example/';
const secrets = [0x41, 0x42].map((n) => new Uint8Array(32).fill(n));
const census = secrets.map((s) => toHex(schnorr.getPublicKey(s)));
const verify = (sig, msg, k) => schnorr.verify(sig, msg, k);
const seats = ['https://seats.example/guardian-1', 'https://seats.example/guardian-2'];
const fetcher = async (url) => {
  const i = seats.findIndex((s) => url.startsWith(s + '/'));
  const nonce = fromHex(new URL(url).searchParams.get('nonce'));
  return Response.json({ node: census[i], sig: toHex(schnorr.sign(identityProofDigest(nonce), secrets[i])) });
};
const client = () => { const c = { gateways: async () => JSON.stringify([GW, 'https://gw-b.example/']) }; pl.noteClientFederation(c, FID); return c; };
const lookup = async () => ({ answers: seats.map((seat) => ({ seat, urls: [GW] })) });
beforeEach(() => forgetProofs());
afterEach(() => pl.useSeatedGateways(null));

test('two guardian seats on one host proving census keys seat their gateway', async () => {
  pl.useSeatedGateways(lookup, { keys: async () => census, verify, fetcher });
  assert.deepEqual(await pl.seatedGatewaysOf(client()), [GW]);
});

test('without the census keys that host is one seat, and one seat seats nothing', async () => {
  pl.useSeatedGateways(lookup, { verify, fetcher });
  assert.deepEqual(await pl.seatedGatewaysOf(client()), []);
});

test('an older lookup handing bare lists still counts each list as a seat', async () => {
  pl.useSeatedGateways(async () => ({ answers: [[GW], [GW]] }));
  assert.deepEqual(await pl.seatedGatewaysOf(client()), [GW]);
});
