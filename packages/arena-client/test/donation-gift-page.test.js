// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// DONATE TO THE DEVELOPERS FROM THE PAGE (2026-10-17): the amounts the popup takes, the split paid in ONE
// transaction to the set's keys with the donor's key as their image, the record the seats read, handed to the first seat that keeps it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '../../arena-node/node_modules/@noble/curves/secp256k1.js';
import { giftDonation, giftAmountOf, giftRecipientsLine } from '../src/donation-gift-page.js';
import { ledgerRows, ledgerHistory } from '../src/page-lock.js';
import { decodeDonationGift, donationGiftId, giftStands, GIFT_TO_GAME, GIFT_TO_NETWORK } from '../../arena-protocol/src/donation-gift.js';
import { fromHex, toHex } from '../../arena-protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const pk33 = (n) => Uint8Array.from([0x02, ...b32(n)]);
const SET = [{ recipientPk: pk33(0x11), label: 'dev a', shareBps: 6667 }, { recipientPk: pk33(0x12), label: 'dev b', shareBps: 3333 }];
const SECRET = b32(0x77), donor = { pubkey: schnorr.getPublicKey(SECRET), sign: (m) => schnorr.sign(m, SECRET) };
const verify = (s, m, k) => schnorr.verify(s, m, k);
const TXID = 'ab'.repeat(32);
const wallet = (paid) => ({
  paySubmit: async (j) => { paid.push(JSON.parse(j)); return JSON.stringify({ txid: TXID, outputs: [] }); },
  lockAccepted: async () => JSON.stringify({ donations: paid[paid.length - 1].map((o, i) => ({ out_idx: i, recipient_pk: o.pk, amount_msat: o.msat, ids_match: true })) }) });

test('the amounts: whole sat from 1 to 10,000,000; the shares line', () => {
  assert.deepEqual(giftAmountOf('1,000'), { ok: true, sat: 1000 });
  assert.deepEqual(giftAmountOf(' 21 '), { ok: true, sat: 21 });
  for (const bad of ['', '0', '1.5', '-3', 'abc', '10000001']) assert.equal(giftAmountOf(bad).ok, false, bad);
  assert.equal(giftRecipientsLine(SET), 'dev a 66.67 % · dev b 33.33 %');
});

test('a gift to a game\'s developers: one payment of the split, the donor\'s image, a record the seats keep', async () => {
  const paid = [], posted = [];
  const fetch = async (u, o) => { posted.push({ u, body: JSON.parse(o.body) }); return u.startsWith('https://s1') ? new Response('down', { status: 503 }) : new Response('{}', { status: 200 }); };
  const got = await giftDonation({ game: { gameDevPubkey: b32(0xde), gameName: 'nextblock' }, recipients: SET, sat: 500, wallet: wallet(paid),
    federationId: 'fe'.repeat(32), donor, seats: ['https://s1.example', 'https://s2.example'], fetch, nowMs: () => 1792240000000 });
  assert.deepEqual([got.ok, got.sat, got.outputs, got.keptBy, got.txid], [true, 500, 2, 'https://s2.example', TXID]);
  assert.deepEqual(paid[0], [{ pk: toHex(pk33(0x11)), msat: '333350', image: toHex(donor.pubkey) }, { pk: toHex(pk33(0x12)), msat: '166650', image: toHex(donor.pubkey) }]);
  const g = { ...decodeDonationGift(fromHex(posted[1].body.gift)), signature: fromHex(posted[1].body.signature) };
  assert.deepEqual([g.target, g.gameName, g.totalMsat, toHex(g.donor)], [GIFT_TO_GAME, 'nextblock', 500000n, toHex(donor.pubkey)]);
  assert.deepEqual(giftStands(g, { recipients: SET, verify, nowMs: 1792240000000 }), { ok: true, id: donationGiftId(g) }, 'the seats\' own rule takes it');
});

test('to the protocol developers; nothing is paid for a bad amount; a seat that keeps nothing is said', async () => {
  const paid = [];
  const fail = async () => new Response('no', { status: 422 });
  const net = await giftDonation({ game: null, recipients: SET, sat: 100, wallet: wallet(paid), federationId: 'fe'.repeat(32), donor, seats: ['https://s.example'], fetch: fail });
  assert.equal(net.ok, false); assert.equal(net.step, 'record'); assert.match(net.why, /paid \(transaction ab/);
  assert.equal(decodeDonationGift(fromHex(JSON.parse(net.retry).gift)).target, GIFT_TO_NETWORK);
  const before = paid.length;
  assert.equal((await giftDonation({ recipients: SET, sat: '0', wallet: wallet(paid), federationId: 'fe'.repeat(32), donor, seats: [], fetch: fail })).step, 'amount');
  assert.equal(paid.length, before, 'nothing paid');
});

test('a paid gift is a row of the wallet\'s history, with its transaction and to whom, even when no seat keeps the record (kanban #682)', async () => {
  const kept = new Map(), storage = { getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => kept.set(k, v) };
  const fed = 'fe'.repeat(32);
  const ok = async () => new Response('{}', { status: 200 }), fail = async () => new Response('no', { status: 422 });
  await giftDonation({ game: { gameDevPubkey: b32(0xde), gameName: 'btc-updown-15m' }, recipients: SET, sat: 100, wallet: wallet([]), federationId: fed, donor, seats: ['https://s.example'], fetch: ok, storage });
  await giftDonation({ recipients: SET, sat: 21, wallet: wallet([]), federationId: fed, donor, seats: ['https://s.example'], fetch: fail, storage });
  await giftDonation({ recipients: SET, sat: '0', wallet: wallet([]), federationId: fed, donor, seats: [], fetch: ok, storage });
  const rows = ledgerRows(storage, fed).map(({ atMs, ...r }) => r);
  assert.deepEqual(rows, [{ kind: 'donation', msat: '100000', round: null, txid: TXID, to: 'app:btc-updown-15m' },
    { kind: 'donation', msat: '21000', round: null, txid: TXID, to: 'network' }], 'the refused amount paid nothing and wrote nothing');
  assert.equal(ledgerHistory(ledgerRows(storage, fed)).length, 2, 'drawn as two rows');
});
