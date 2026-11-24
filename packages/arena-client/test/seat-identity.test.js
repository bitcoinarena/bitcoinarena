// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// ONE SEAT, ONE VOTE (kanban #3574): the URLs of one host are one seat unless each proves a distinct node key of the round at
// GET /identity?nonce= - so seven seats behind one public host (/guardian-1 .. /guardian-7) stay seven, and one box under three paths is one.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { seatsOf, seatVoice, identityProofDigest, forgetProofs } from '../src/seat-identity.js';
import { settlementOf } from '../src/page-lock.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const secrets = Array.from({ length: 7 }, (_, i) => b32(0x41 + i));
const keys = secrets.map((s) => toHex(schnorr.getPublicKey(s)));
const verify = (sig, msg, key) => schnorr.verify(sig, msg, key);
const guardians = secrets.map((_, i) => `https://seats.example/guardian-${i + 1}`);
const liar = ['https://liar.example/a', 'https://liar.example/b', 'https://liar.example/c'];

// GET /identity?nonce=: a guardian signs with its own key; `claim` makes a box answer for a key it does not hold (a replayed or made-up sig)
const identity = (url, { claim = null } = {}) => {
  const nonce = fromHex(new URL(url).searchParams.get('nonce'));
  const i = guardians.findIndex((g) => url.startsWith(g + '/'));
  if (i >= 0) return Response.json({ node: keys[i], sig: toHex(schnorr.sign(identityProofDigest(nonce), secrets[i])) });
  if (claim !== null) return Response.json({ node: keys[claim], sig: toHex(schnorr.sign(identityProofDigest(nonce), b32(0x99))) });
  return new Response('no', { status: 404 });
};
beforeEach(() => forgetProofs());

test('seven seats behind one host that each prove a round key are seven seats', async () => {
  const seats = await seatsOf(guardians, { keys, verify, fetcher: async (u) => identity(u) });
  assert.equal(seats.length, 7);
  assert.deepEqual(seats.map((s) => s.urls), guardians.map((g) => [g]));
  assert.deepEqual(seats.map((s) => s.key), keys);
});

test('one box under three paths that proves nothing is one seat; claiming a round key without its signature does not help', async () => {
  for (const claim of [null, 0]) {
    forgetProofs();
    const seats = await seatsOf([...guardians, ...liar], { keys, verify, fetcher: async (u) => identity(u, { claim }) });
    assert.equal(seats.length, 8, `claim ${claim}`);
    assert.deepEqual(seats[7].urls, liar);
    assert.equal(seats[7].key, null);
  }
});

test('without the round keys a host is one seat; a URL alone on its host is a seat and is not asked who it is', async () => {
  const asked = [];
  const seats = await seatsOf(['https://a.example', 'https://b.example/x', ...guardians], { fetcher: async (u) => { asked.push(u); return identity(u); } });
  assert.deepEqual(seats.map((s) => s.urls.length), [1, 1, 7]);
  assert.deepEqual(asked, []);
});

test('a key the round did not draw does not make a seat of its own', async () => {
  const seats = await seatsOf(guardians, { keys: keys.slice(0, 5), verify, fetcher: async (u) => identity(u) });
  assert.deepEqual(seats.map((s) => s.urls.length), [1, 1, 1, 1, 1, 2]);
  assert.equal(seats[5].key, null);
});

test('a seat whose URLs disagree has no voice', () => {
  const k = (a) => a.k;
  assert.equal(seatVoice([{ k: 'x' }, { k: null }, { k: 'x' }], k).k, 'x');
  assert.equal(seatVoice([{ k: 'x' }, { k: 'y' }], k), null);
  assert.equal(seatVoice([{ k: null }], k), null);
});

test('settlement: the live layout (seven seats on one host) agrees 5 of 7, and three paths of one box do not outvote it', async () => {
  const rid = b32(0x61);
  const settled = (payee) => Response.json({ state: 'ACCEPTED', txid: 'ef'.repeat(32), moved: { payouts: [{ kind: 'qualifier', pk: payee, msat: '978000' }] } });
  const fetcher = async (u) => {
    if (u.includes('/identity')) return identity(u);
    return settled(liar.some((l) => u.startsWith(l)) ? 'bb'.repeat(32) : 'aa'.repeat(32));
  };
  const s = await settlementOf({ roundId: rid, nodes: [...liar, ...guardians.slice(0, 5)], fetcher, needed: 5, keys, verify });
  assert.equal(s.ok, true);
  assert.equal(s.agreeing, 5);
  assert.equal(s.moved.payouts[0].pk, 'aa'.repeat(32));
  // without the proofs the host of the seven seats is one seat, and the box's one seat ties with it - the threshold is never met by URLs
  forgetProofs();
  const t = await settlementOf({ roundId: rid, nodes: [...liar, ...guardians.slice(0, 5)], fetcher, needed: 5 });
  assert.equal(t.needed, 2, 'the threshold is capped by seats, not URLs');
  assert.equal(t.ok, false, 'one seat against one seat agrees on nothing');
});
