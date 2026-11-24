// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3575: GET /items answers count once per seat. Two paths of one box make up no purchase; two seats behind one host (as live) that
// each prove a key of the census confirm a real one.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { ownedItems } from '../src/item-buy.js';
import { identityProofDigest, forgetProofs } from '../src/seat-identity.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const secrets = [0x41, 0x42].map((n) => new Uint8Array(32).fill(n));
const census = secrets.map((s) => toHex(schnorr.getPublicKey(s)));
const verify = (sig, msg, k) => schnorr.verify(sig, msg, k);
const seats = ['https://seats.example/guardian-1', 'https://seats.example/guardian-2'];
const REAL = { id: 'cd'.repeat(32), itemId: 'large-truck', gameName: 'nextblock' };
const FAKE = { id: 'ab'.repeat(32), itemId: 'large-truck', gameName: 'nextblock' };
const fetch = async (url) => {
  if (url.includes('/identity?nonce=')) {
    const i = seats.findIndex((s) => url.startsWith(s + '/'));
    if (i < 0) return new Response('no', { status: 404 });
    const nonce = fromHex(new URL(url).searchParams.get('nonce'));
    return Response.json({ node: census[i], sig: toHex(schnorr.sign(identityProofDigest(nonce), secrets[i])) });
  }
  if (url.startsWith('https://liar.example/')) return Response.json({ items: [FAKE] });
  if (url.startsWith('https://seats.example/')) return Response.json({ items: [REAL] });
  return Response.json({ items: [] });
};
beforeEach(() => forgetProofs());

test('two paths of one box do not make up a purchase the honest seats do not keep', async () => {
  const owned = await ownedItems({ seats: ['https://liar.example/a', 'https://liar.example/b', 'https://a.example', 'https://b.example'], player: new Uint8Array(32).fill(1), gameName: 'nextblock', fetch, keys: census, verify });
  assert.deepEqual(owned, []);
});

test('two seats behind one host that prove census keys keep the real purchase', async () => {
  const owned = await ownedItems({ seats: [...seats, 'https://a.example'], player: new Uint8Array(32).fill(1), gameName: 'nextblock', fetch, keys: census, verify });
  assert.deepEqual(owned.map((x) => x.id), [REAL.id]);
});
