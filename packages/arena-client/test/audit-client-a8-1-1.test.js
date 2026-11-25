// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Audit client a8-1-1 (attacker audit 2026-11-25, round 1): the #3574 fix (seat-identity.js seatsOf) takes a relayed
// GET /identity?nonce= answer as proof. One box under three paths of a link passes each identity ask on to a different seat of
// the round (unchanged nonce, the seat's own answer handed back), so its three paths become three "proven" seats of the round and
// its unsigned ACCEPTED settlement outvotes the round's two honest seats on /lock-settlement again.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { identityProofDigest, forgetProofs } from '../src/seat-identity.js';
import { settlementOf } from '../src/page-lock.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const secrets = [b32(0x41), b32(0x42), b32(0x43)];
const keys = secrets.map((s) => toHex(schnorr.getPublicKey(s)));
const verify = (sig, msg, key) => schnorr.verify(sig, msg, key);
// the round's three seats, each alone on its host; the link names the first two
const honest = ['https://h1.example', 'https://h2.example', 'https://h3.example'];
const liar = ['https://liar.example/a', 'https://liar.example/b', 'https://liar.example/c'];

// a seat's own /identity: it signs the nonce it is handed (arena-node server.js does exactly this)
const seatIdentity = (i, nonceHex) => Response.json({ node: keys[i], sig: toHex(schnorr.sign(identityProofDigest(fromHex(nonceHex)), secrets[i])) });

const rid = b32(0x61);
const settled = (payee) => Response.json({ state: 'ACCEPTED', txid: 'ef'.repeat(32), moved: { payouts: [{ kind: 'qualifier', pk: payee, msat: '978000' }] } });

const fetcher = async (u) => {
  const url = new URL(u);
  if (url.pathname.endsWith('/identity')) {
    const nonce = url.searchParams.get('nonce');
    const h = honest.findIndex((x) => u.startsWith(x + '/'));
    if (h >= 0) return seatIdentity(h, nonce);
    // THE BOX: each path relays the ask, nonce unchanged, to one seat of the round, and hands its answer back
    const l = liar.findIndex((x) => u.startsWith(x + '/'));
    if (l >= 0) return seatIdentity(l, nonce);
    return new Response('no', { status: 404 });
  }
  // honest seats pay the winner aa..; the box answers a settlement that leaves her out
  return settled(liar.some((l) => u.startsWith(l)) ? 'bb'.repeat(32) : 'aa'.repeat(32));
};

beforeEach(() => forgetProofs());

test('control: the box whose paths prove nothing is one seat and the honest settlement stands', async () => {
  const noRelay = async (u) => (liar.some((l) => u.startsWith(l)) && u.includes('/identity') ? new Response('no', { status: 404 }) : fetcher(u));
  const s = await settlementOf({ roundId: rid, nodes: [honest[0], honest[1], ...liar], fetcher: noRelay, needed: 2, keys, verify });
  assert.equal(s.ok, true);
  assert.equal(s.moved.payouts[0].pk, 'aa'.repeat(32));
});

test('audit client a8-1-1: one box relaying /identity to the round seats must not outvote them on /lock-settlement', async () => {
  const s = await settlementOf({ roundId: rid, nodes: [honest[0], honest[1], ...liar], fetcher, needed: 2, keys, verify });
  console.log('FACTS a8-1-1:', JSON.stringify({ ok: s.ok, pk: s.moved && s.moved.payouts[0].pk, agreeing: s.agreeing, needed: s.needed, seats: s.seats }));
  assert.notEqual(s.ok && s.moved.payouts[0].pk, 'bb'.repeat(32),
    'three paths of one box that relay the seats\' identity proofs decided the winner\'s settlement');
});
