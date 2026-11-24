// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3589: a row's key is confirmed by seats, not URLs. Seats behind one host (/guardian-1 .. /guardian-3, as live) that each prove a key of
// the checked census confirm it; without those keys the host is one seat, and its views alone confirm nothing.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { fetchSeason, confirmRows } from '../src/season-view.js';
import { identityProofDigest, forgetProofs } from '../src/seat-identity.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const key = (n) => n.toString(16).padStart(2, '0').repeat(32);
const HONEST = key(0x5a);
const secrets = [0x41, 0x42, 0x43].map((n) => new Uint8Array(32).fill(n));
const census = secrets.map((s) => toHex(schnorr.getPublicKey(s)));
const verify = (sig, msg, k) => schnorr.verify(sig, msg, k);
const seats = secrets.map((_, i) => `https://seats.example/guardian-${i + 1}`);
const board = { node: key(0x01), game: { name: 'nextblock', ids: [key(0x0a)] }, days: 7, scope: 'network', agree: 3, seats: { asked: 3, answered: 3 }, rounds: 41, leftOut: 0,
  rows: [{ rank: 1, player: HONEST, name: 'Satoshi', rounds: 40, wins: 30, netMsat: '900000', bestScore: 1 }] };
const fetch = async (url) => {
  if (url.includes('/identity?nonce=')) {
    const i = seats.findIndex((s) => url.startsWith(s + '/'));
    const nonce = fromHex(new URL(url).searchParams.get('nonce'));
    return Response.json({ node: census[i], sig: toHex(schnorr.sign(identityProofDigest(nonce), secrets[i])) });
  }
  return Response.json(board);
};
beforeEach(() => forgetProofs());

test('three seats on one host proving census keys confirm the leader\'s key', async () => {
  let asked = 0;
  const v = await fetchSeason({ nodes: seats, game: 'nextblock', days: 7, fetch, race: 8, answerMs: 45000, verify, keys: async () => { asked++; return census; } });
  assert.equal(v.rows[0].player, HONEST);
  assert.equal(!!v.rows[0].keyUnconfirmed, false);
  assert.equal(asked, 1);
});

test('without the census keys one host is one seat: its views confirm nothing', async () => {
  const v = await fetchSeason({ nodes: seats, game: 'nextblock', days: 7, fetch, race: 8, answerMs: 45000, verify });
  assert.equal(v.rows[0].keyUnconfirmed, true);
});

test('a seat whose views disagree confirms neither key', () => {
  const view = (seat, player) => ({ seat, rows: [{ name: 'Satoshi', player }] });
  assert.equal(confirmRows([view('a/x', HONEST), view('a/y', HONEST), view('b', HONEST)]).rows[0].keyUnconfirmed, undefined, 'per URL by default');
  const bySeat = confirmRows([view('a/x', HONEST), view('a/y', key(0xee)), view('b', HONEST)], (v) => v.seat[0]);
  assert.equal(bySeat.rows[0].keyUnconfirmed, true);
});
