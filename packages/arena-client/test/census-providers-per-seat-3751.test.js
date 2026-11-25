// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE TWO CENSUS PROVIDERS ARE TWO SEATS (kanban #3751, the #3574 rule at the #1333 door): the URLs of one host are one provider unless each
// proves a distinct node key of the round (the contract's nodes) - the live seats behind one host stay several, two paths of one box are one.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { censusEvidenceFor } from '../src/committee.js';
import { identityProofDigest, forgetProofs } from '../src/seat-identity.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const secrets = [b32(0x41), b32(0x42), b32(0x43)];
const keys = secrets.map((s) => schnorr.getPublicKey(s));
const verify = (sig, msg, key) => schnorr.verify(sig, msg, key);
const bond = (n) => ({ txid: String(n).padStart(2, '0').repeat(32), vout: 0, pubkey: 'aa'.repeat(32) });
const FULL = [bond(1), bond(2), bond(3)], SUBSET = [bond(1), bond(2)];
const seats = ['https://seats.example/guardian-1', 'https://seats.example/guardian-2', 'https://seats.example/guardian-3'];
const liar = ['https://liar.example/a', 'https://liar.example/b'];
const proof = (i, u) => Response.json({ node: toHex(keys[i]), sig: toHex(schnorr.sign(identityProofDigest(fromHex(new URL(u).searchParams.get('nonce'))), secrets[i])) });
const fetcherOf = ({ relay = false } = {}) => async (u) => {
  const i = seats.findIndex((s) => u.startsWith(s + '/'));
  const l = liar.findIndex((s) => u.startsWith(s + '/'));
  if (u.includes('/identity')) {
    if (i >= 0) return proof(i, u);
    if (l >= 0 && relay) return proof(l, u);
    return new Response('no', { status: 404 });
  }
  if (l >= 0) return Response.json({ entries: SUBSET });
  if (i >= 0) { await new Promise((r) => setTimeout(r, 40)); return Response.json({ entries: FULL }); }
  throw new Error('no answer');
};
let n = 0x20;
const contract = () => ({ censusRoot: b32(n++), nodes: keys });
beforeEach(() => forgetProofs());

test('the live layout: seats behind one host that prove the round\'s keys are two providers, lock-grade', async () => {
  const got = await censusEvidenceFor('ab'.repeat(32), contract(), seats, { fetcher: fetcherOf(), verify });
  assert.equal(got.ok, true);
  assert.equal(got.fromNodes.length, 2);
});

test('two paths of one box that prove nothing are one provider beside the seats: the seats\' list is in the union', async () => {
  const got = await censusEvidenceFor('ab'.repeat(32), contract(), [...liar, seats[0]], { fetcher: fetcherOf(), verify });
  assert.equal(got.ok, true);
  assert.ok(got.entries.some((e) => e.txid === bond(3).txid), `from ${got.from}`);
  // the box alone, under both paths: enough to look, not to lock
  const alone = await censusEvidenceFor('ab'.repeat(32), contract(), liar, { fetcher: fetcherOf(), verify });
  assert.equal(alone.ok, false);
  assert.equal(alone.lookOnly, true);
});

test('a box relaying the seats\' identity proofs is one seat with each seat it relays (kanban #3730), never two providers of its own', async () => {
  const got = await censusEvidenceFor('ab'.repeat(32), contract(), [...liar, seats[0], seats[1]], { fetcher: fetcherOf({ relay: true }), verify });
  assert.equal(got.ok, true);
  assert.ok(got.entries.some((e) => e.txid === bond(3).txid), `from ${got.from}`);
});

test('without the round\'s keys a host is one provider (paths of one URL source fold into it)', async () => {
  const got = await censusEvidenceFor('ab'.repeat(32), { censusRoot: b32(n++) }, ['https://liar.example/a/x', 'https://liar.example/a/y', ...liar], { fetcher: fetcherOf() });
  assert.equal(got.lookOnly, true);
});
