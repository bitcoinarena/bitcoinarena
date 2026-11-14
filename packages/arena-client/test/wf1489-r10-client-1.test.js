// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WF1489 r10 client-1: collectZaps' referral total is summed over every seat's unchecked /donations rows.
// (a) One seat's 'website' row with a non-integer amountMsat makes BigInt() throw AFTER the honest zaps were refunded and noted
//     collected: the page (index.html collect()) never gets `got`, so the collected zaps never reach the wallet history, and every
//     later pass throws again.
// (b) One seat's made-up 'website' row (no contract at its outpoint) is counted in the referral total the Settings card shows.
// Safe behaviour: a malformed row is dropped, and the referral total counts only what this wallet could collect.
import test from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '../../arena-node/node_modules/@noble/curves/secp256k1.js';
import { collectZaps } from '../src/identity.js';
import { refundKeyOf } from '../../arena-protocol/src/stake-lock.js';
import { identitySecretFor } from '../../arena-protocol/src/player-key.js';
import { fromHex, toHex } from '../../arena-protocol/src/hash.js';

const curve = { pointX: (sk) => schnorr.getPublicKey(sk), signSchnorr: (m, sk) => schnorr.sign(m, sk) };
const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
const SEED = 'ab'.repeat(32);
const F = 'fe'.repeat(32);
const pk = toHex(refundKeyOf(curve.pointX(identitySecretFor(fromHex(SEED)))));
const REAL = `${'cd'.repeat(32)}:0`;
const honestRow = { outpoint: REAL, federationId: F, amountMsat: '21000', item: null };
const seatsAnswer = (rowsBySeat) => async (u) => {
  const seat = new URL(u).host;
  return new Response(JSON.stringify({ donations: rowsBySeat[seat] || [] }), { status: 200 });
};
// the federation holds only the real zap's contract
const client = { refund: async (txid, outIdx) => (`${txid}:${outIdx}` === REAL
  ? JSON.stringify({ accepted: true, txid: 'f0'.repeat(32) }) : JSON.stringify({ accepted: false, stored_before: null })) };

test('one seat\'s website row with a fractional amountMsat does not make collectZaps throw after it collected', async () => {
  const s = mem(); s.setItem('arena.player.seed', SEED);
  const keep = mem();
  const fetcher = seatsAnswer({ 'a.example': [honestRow], 'b.example': [{ outpoint: `${'ee'.repeat(32)}:1`, federationId: F, amountMsat: 1.5, item: 'website' }] });
  let got, threw = null;
  try { got = await collectZaps({ storage: s, keep, curve, clients: new Map([[F, client]]), seats: ['https://a.example', 'https://b.example'], fetcher }); }
  catch (e) { threw = e; }
  assert.equal(threw, null, `collectZaps threw (${threw && threw.message}) after refunding: the page never records the collected zap`);
  assert.equal(got.collected.length, 1);
  assert.equal(got.totalMsat, '21000');
});

test('one seat\'s made-up website row is not counted in the referral total the page shows', async () => {
  const s = mem(); s.setItem('arena.player.seed', SEED);
  const keep = mem();
  const fetcher = seatsAnswer({ 'a.example': [honestRow], 'b.example': [{ outpoint: `${'ee'.repeat(32)}:1`, federationId: F, amountMsat: '100000000000', item: 'website' }] });
  const got = await collectZaps({ storage: s, keep, curve, clients: new Map([[F, client]]), seats: ['https://a.example', 'https://b.example'], fetcher });
  assert.equal(got.key, pk);
  assert.equal(got.referral.msat, '0', `the referral total shows ${got.referral.msat} msat from one seat's row that no contract backs`);
});
