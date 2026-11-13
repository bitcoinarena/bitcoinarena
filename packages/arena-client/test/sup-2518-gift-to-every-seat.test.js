// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Adapted to 1.9 by #2536 (kanban #2518): the fixture's keys were not curve points, which 1.9 refuses before paying ("no 33-byte compressed
// secp256k1 key"); real keys here, the attack unchanged.
// kanban #1489 round 12 (client): ONE SEAT ANSWERING 200 TO POST /donation-gift BURIES A PAID GIFT OR ZAP. giftDonation (the developers' gift
// popup, and zapPlayer - a season-board zap to another player's identity key) pays the federation first, then hands the signed record to the
// FIRST seat that answers ok and stops ("it hands it on to every other"). A seat listed first that answers 200 and keeps nothing (or keeps it
// and never gossips it) leaves the record at no honest seat: the zapped player's collectZaps and the developers' donor read the seats' /donations
// and never learn of the payout contract; the donor's sats sit in a contract nobody collects. The page offers no re-send (the `retry` body is
// handed back only when NO seat answered ok). Safe: one seat's ok is not the end of the hand-over - the record reaches the other seats too.
import test from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '../../arena-node/node_modules/@noble/curves/secp256k1.js';
import { zapPlayer, giftDonation } from '../src/donation-gift-page.js';

const b32 = (n) => new Uint8Array(32).fill(n);
// real curve points (1.9 refuses a gift split over a key that is no compressed secp256k1 point)
const pk33 = (n) => Uint8Array.from([0x02, ...schnorr.getPublicKey(b32(n))]);
const SET = [{ recipientPk: pk33(0x11), label: 'dev a', shareBps: 10000 }];
const SECRET = b32(0x77), donor = { pubkey: schnorr.getPublicKey(SECRET), sign: (m) => schnorr.sign(m, SECRET) };
const TXID = 'ab'.repeat(32);
const wallet = () => {
  const paid = [];
  return { paid,
    paySubmit: async (j) => { paid.push(JSON.parse(j)); return JSON.stringify({ txid: TXID, outputs: [] }); },
    lockAccepted: async () => JSON.stringify({ donations: paid[paid.length - 1].map((o, i) => ({ out_idx: i, recipient_pk: o.pk, amount_msat: o.msat, ids_match: true })) }) };
};
const SEATS = ['https://liar.example', 'https://s2.example', 'https://s3.example', 'https://s4.example'];
// the liar answers 200 and keeps nothing; the honest seats keep what they are handed
const seatsFetch = (kept) => async (u, o) => {
  if (u.startsWith('https://liar')) return new Response('{}', { status: 200 });
  kept.push(new URL(u).host);
  return new Response('{}', { status: 201 });
};

test('wf1489-r12-client-1: a zap to a player is not left with the one seat that answered 200 first', async () => {
  const kept = [], w = wallet();
  const got = await zapPlayer({ player: schnorr.getPublicKey(b32(0x42)), sat: 100, wallet: w, federationId: 'fe'.repeat(32), donor, seats: SEATS, fetch: seatsFetch(kept), nowMs: () => 1792240000000 });
  console.log('  GOT zap', JSON.stringify(got));
  assert.equal(w.paid.length, 1, 'the zap was paid');
  assert.ok(kept.length >= 1, `the paid zap's record reached no honest seat (handed only to ${got.keptBy}, which kept nothing): the recipient never learns of it`);
});

test('wf1489-r12-client-1: a developers\' gift is not left with the one seat that answered 200 first', async () => {
  const kept = [], w = wallet();
  const got = await giftDonation({ game: { gameDevPubkey: b32(0xde), gameName: 'nextblock' }, recipients: SET, sat: 500, wallet: w,
    federationId: 'fe'.repeat(32), donor, seats: SEATS, fetch: seatsFetch(kept), nowMs: () => 1792240000000 });
  console.log('  GOT gift', JSON.stringify(got));
  assert.equal(w.paid.length, 1, 'the gift was paid');
  assert.ok(kept.length >= 1, `the paid gift's record reached no honest seat (handed only to ${got.keptBy})`);
});
