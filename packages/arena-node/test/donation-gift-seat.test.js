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

// ON THE SITE ALL TO THE PROTOCOL DEVELOPERS, IN AN APP HALF EACH, TAGGED WITH WHERE (kanban #672: "when clicking donate on the main
// Testnet site the donation goes too 100% to protocol devs. If it's within an app 50% to protocol devs, 50% to game devs. That donation is
// tagged so we know its origin and we can filter by it in the donation owner dashboard")
test('a gift inside an app pays half over each set and says its origin; one on the site says "site"; version 1 records keep their bytes', async () => {
  const { GIFT_TO_BOTH } = await import('../../arena-protocol/src/donation-gift.js');
  const { donationsPage, donationOrigin } = await import('../src/dev-clients.js');
  const NET = [{ recipientPk: pk33(0x21), label: 'protocol a', shareBps: 5000 }, { recipientPk: pk33(0x22), label: 'protocol b', shareBps: 5000 }];
  const totalMsat = 1000000n;
  const outs = giftOutputs({ totalMsat, networkSet: NET, gameSet: SET });
  assert.deepEqual(outs.map((o) => [toHex(o.pk).slice(0, 4), o.msat]), [['0221', 250000n], ['0222', 250000n], ['0211', 333350n], ['0212', 166650n]], 'half over the protocol set, half over the app\'s');
  const body = { target: GIFT_TO_BOTH, gameDevPubkey: b32(0xde), gameName: 'rock-paper-scissors', origin: 'app:rock-paper-scissors', donor: DONOR, federationId: b32(0xfe),
    txid: b32(0x7b), totalMsat, outputs: outs.map((o, i) => ({ outIdx: i, pk: o.pk, msat: o.msat })), atMs: BigInt(NOW) };
  assert.deepEqual(decodeDonationGift(encodeDonationGift(body)), body, 'version 2 round-trips with its origin');
  const g = { ...body, signature: schnorr.sign(donationGiftId(body), SECRET) };
  const db = openStore(':memory:'); const rows = [];
  assert.match(giftStands(g, { recipients: SET, verify, nowMs: NOW }).why, /checked against both/);
  const kept = await keepDonationGift({ g, networkSet: NET, gameSet: SET, port: fedWith(heldFor(g)), db, verify, keepRows: (r) => rows.push(...r), nowMs: NOW });
  assert.deepEqual([kept.ok, kept.outputs], [true, 4]);
  assert.deepEqual([...new Set(rows.map((r) => r.item))], ['donation · protocol + rock-paper-scissors · from app:rock-paper-scissors']);
  const wrong = await keepDonationGift({ g: { ...g, txid: b32(0x7c) }, networkSet: SET, gameSet: NET, port: fedWith(heldFor(g)), db, verify, nowMs: NOW });
  assert.equal(wrong.ok, false, 'the halves over the wrong sets: refused');
  // the site's: to the protocol set alone, tagged
  const site = { target: GIFT_TO_NETWORK, gameDevPubkey: new Uint8Array(32), gameName: '', origin: 'site', donor: DONOR, federationId: b32(0xfe), txid: b32(0x7d), totalMsat,
    outputs: giftOutputs({ totalMsat, recipients: NET }).map((o, i) => ({ outIdx: i, pk: o.pk, msat: o.msat })), atMs: BigInt(NOW) };
  assert.equal(decodeDonationGift(encodeDonationGift(site)).origin, 'site');
  const v1 = gift(500); const { signature, ...v1body } = v1;
  assert.equal(encodeDonationGift(v1body)[2], 1, 'no origin: still version 1, the same bytes and id as before');
  assert.equal(signature.length, 64);
  // the owner's table: each donation's origin, and a filter by it
  const info = [{ r: { item: 'donation · protocol · from site', amountMsat: '1000', verifiedMs: 3 }, protocolMsat: 1000n, appMsat: 0n },
    { r: { item: 'donation · protocol + rock-paper-scissors · from app:rock-paper-scissors', amountMsat: '2000', verifiedMs: 2 }, protocolMsat: 1000n, appMsat: 1000n },
    { r: { item: 'donation · protocol', amountMsat: '500', verifiedMs: 1 }, protocolMsat: 500n, appMsat: 0n },
    { r: { roundId: 'ab', amountMsat: '700', verifiedMs: 4 }, game: 'nextblock', title: 'Tick Tock', protocolMsat: 350n, appMsat: 350n }];
  assert.deepEqual(info.map(donationOrigin), ['site', 'app:rock-paper-scissors', 'gift', 'round']);
  const all = donationsPage(info, {}, {});
  assert.deepEqual(all.origins.map((o) => [o.origin, o.title, o.count]), [['site', 'Donate on the site', 1], ['app:rock-paper-scissors', 'Donate in rock-paper-scissors', 1], ['gift', 'Donate (before tags)', 1], ['round', 'Rounds', 1]]);
  const fromSite = donationsPage(info, {}, { origin: 'site' });
  assert.deepEqual([fromSite.total, fromSite.rows[0].origin, fromSite.sums.msat], [1, 'site', '1000']);
});
