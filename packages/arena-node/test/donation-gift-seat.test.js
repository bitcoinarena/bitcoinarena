// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A DONATION TO THE DEVELOPERS OUTSIDE ANY ROUND (2026-10-17: "B e cash"): the protocol record, the split over the
// set (100 / 500 / 1000 / 5000 sat or custom), the seat's checks against the set and the federation, and the outputs indexed for the
// developers' own clients (the rows GET /donations?key= serves).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openStore } from '../src/store.js';
import { keepDonationGift, giftsOf } from '../src/donation-gift-seat.js';
import { encodeDonationGift, decodeDonationGift, donationGiftId, giftOutputs, giftStands, GIFT_TO_GAME, GIFT_TO_NETWORK, GIFT_CHOICES_SAT } from '../../arena-protocol/src/donation-gift.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const pk33 = (n) => Uint8Array.from([0x02, ...b32(n)]);
const SECRET = b32(0x77), DONOR = schnorr.getPublicKey(SECRET);
const verify = (s, m, k) => schnorr.verify(s, m, k);
const SET = [{ recipientPk: pk33(0x11), label: 'dev a', shareBps: 6667 }, { recipientPk: pk33(0x12), label: 'dev b', shareBps: 3333 }];
const NOW = 1792240000000;
const cid = (f) => createHash('sha256').update(JSON.stringify(f, (k, v) => (typeof v === 'bigint' ? String(v) : v instanceof Uint8Array ? toHex(v) : v))).digest('hex');
const fedWith = (held) => ({ status: async (o) => { const c = held.get(`${toHex(o.txid)}:${o.outIdx}`); return c ? { stored: { contractId: c } } : null; }, contractId: async (f) => cid(f) });
const heldFor = (g) => new Map(g.outputs.map((o) => [`${toHex(g.txid)}:${o.outIdx}`, cid({ paymentImage: { kind: 'hash', bytes: g.donor }, amountMsat: o.msat, claimPk: o.pk, refundPk: o.pk, expiration: 0 })]));

function gift(sat, { txid = b32(0x7a), target = GIFT_TO_GAME, outputs = null, secret = SECRET } = {}) {
  const totalMsat = BigInt(sat) * 1000n;
  const outs = outputs || giftOutputs({ totalMsat, recipients: SET }).map((o, i) => ({ outIdx: i, pk: o.pk, msat: o.msat }));
  const g = { target, gameDevPubkey: b32(0xde), gameName: target === GIFT_TO_GAME ? 'nextblock' : '', donor: DONOR, federationId: b32(0xfe), txid, totalMsat, outputs: outs, atMs: BigInt(NOW) };
  return { ...g, signature: schnorr.sign(donationGiftId(g), secret) };
}

test('the record round-trips; the four choices split 66.67 / 33.33 % over the set with the remainder to the first key', () => {
  assert.deepEqual([...GIFT_CHOICES_SAT], [100, 500, 1000, 5000]);
  const g = gift(1000); const { signature, ...body } = g;
  assert.deepEqual(decodeDonationGift(encodeDonationGift(body)), body);
  assert.deepEqual(giftOutputs({ totalMsat: 100000n, recipients: SET }).map((o) => o.msat), [66670n, 33330n]);
  assert.deepEqual(giftOutputs({ totalMsat: 5000000n, recipients: SET }).map((o) => o.msat), [3333500n, 1666500n]);
  assert.deepEqual(giftOutputs({ totalMsat: 1000n, recipients: SET }).map((o) => o.msat), [667n, 333n], 'a custom 1 sat');
  const net = gift(500, { target: GIFT_TO_NETWORK });
  assert.equal(decodeDonationGift(encodeDonationGift({ ...net, signature: undefined })).gameName, '');
  assert.throws(() => encodeDonationGift({ ...body, totalMsat: 999n }), /at least 1 sat/);
});

test('a seat keeps a gift whose outputs are the split and that the federation holds; indexed per recipient key; one payment, one gift', async () => {
  const db = openStore(':memory:'); const rows = [];
  const g = gift(500);
  const args = { g, recipients: SET, port: fedWith(heldFor(g)), db, verify, keepRows: (r) => rows.push(...r), nowMs: NOW };
  const a = await keepDonationGift(args);
  assert.deepEqual([a.ok, a.kept, a.outputs], [true, 'new', 2]);
  assert.deepEqual(rows.map((r) => [toHex(r.recipientPk).slice(0, 4), r.amountMsat, r.item, r.image === toHex(DONOR)]), [['0211', 333350n, 'donation · nextblock', true], ['0212', 166650n, 'donation · nextblock', true]]);
  assert.equal((await keepDonationGift(args)).kept, 'held', 'handed on again: the same gift');
  const other = gift(1000);   // the same transaction named by another record
  assert.equal((await keepDonationGift({ ...args, g: other, port: fedWith(heldFor(other)) })).status, 409);
  assert.deepEqual(giftsOf(db, toHex(DONOR)).map((x) => [x.gameName, x.totalMsat]), [['nextblock', '500000']]);
});

test('refused: a forged signature, outputs that are not the split, outputs the federation does not hold, a future date', async () => {
  const db = openStore(':memory:');
  const forged = gift(100, { secret: b32(0x55) });
  assert.match((await keepDonationGift({ g: forged, recipients: SET, port: fedWith(heldFor(forged)), db, verify, nowMs: NOW })).why, /signature/);
  const skim = gift(100, { outputs: [{ outIdx: 0, pk: pk33(0x11), msat: 100000n }] });   // everything to one key
  assert.match((await keepDonationGift({ g: skim, recipients: SET, port: fedWith(heldFor(skim)), db, verify, nowMs: NOW })).why, /1 output\(s\), and its total split over the set is 2/);
  const g = gift(100, { txid: b32(0x7b) });
  assert.match((await keepDonationGift({ g, recipients: SET, port: fedWith(new Map()), db, verify, nowMs: NOW })).why, /holds nothing/);
  assert.match(giftStands(g, { recipients: SET, verify, nowMs: NOW - 11 * 60 * 1000 }).why, /dated ahead/);
});

test('a zap: its one output to the player\'s identity refund key, kept and indexed as "zap" under that key', async () => {
  const { playerGiftRecipients, GIFT_TO_PLAYER } = await import('../../arena-protocol/src/donation-gift.js');
  const { refundKeyOf } = await import('../../arena-protocol/src/stake-lock.js');
  const player = schnorr.getPublicKey(b32(0x42));
  const recipients = playerGiftRecipients(player);
  const outs = giftOutputs({ totalMsat: 21000n, recipients }).map((o, i) => ({ outIdx: i, pk: o.pk, msat: o.msat }));
  const body = { target: GIFT_TO_PLAYER, gameDevPubkey: player, gameName: '', donor: DONOR, federationId: b32(0xfe), txid: b32(0x7c), totalMsat: 21000n, outputs: outs, atMs: BigInt(NOW) };
  const g = { ...body, signature: schnorr.sign(donationGiftId(body), SECRET) };
  const db = openStore(':memory:'); const rows = [];
  const a = await keepDonationGift({ g, recipients, port: fedWith(heldFor(g)), db, verify, keepRows: (r) => rows.push(...r), nowMs: NOW });
  assert.deepEqual([a.ok, a.kept, a.outputs], [true, 'new', 1]);
  assert.deepEqual(rows.map((r) => [toHex(r.recipientPk), r.amountMsat, r.item]), [[toHex(refundKeyOf(player)), 21000n, 'zap']]);
  // a zap to another key than the player's is refused
  const skim = { ...body, txid: b32(0x7d), outputs: [{ outIdx: 0, pk: pk33(0x11), msat: 21000n }] };
  const sg = { ...skim, signature: schnorr.sign(donationGiftId(skim), SECRET) };
  assert.equal((await keepDonationGift({ g: sg, recipients, port: fedWith(heldFor(sg)), db, verify, nowMs: NOW })).ok, false);
});
