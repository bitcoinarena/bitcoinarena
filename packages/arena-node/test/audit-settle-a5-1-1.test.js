// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AUDIT settle a5-1-1: a donation gift (and an item purchase) to the protocol developers' set while that set VESTS (§27A.4.1).
// The page splits the gift over the network set vested at the lobby round's CENSUS height (arena-client donation-pay.js:482
// fetchDonationSet -> target.network = vestedShares(set.recipients, round.censusHeight); index.html donateSets -> giftDonation),
// pays the outputs, then posts the signed record. The seat checks it against the set vested at ITS CHAIN TIP
// (server.js POST /donation-gift networkSetOf: vestedShares(forced.recipients, chainTip())). A day's series rounds share one census
// height (duty-day.js), so the tip is routinely one or more vesting steps (144 blocks) past it: every seat refuses the record after
// the federation already holds the outputs, the developers' rows are never indexed (GET /donations), and the donor's sats are gone.
// SAFE BEHAVIOUR asserted: a gift the page split exactly as the protocol says for its round's census height is kept by a seat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openStore } from '../src/store.js';
import { keepDonationGift } from '../src/donation-gift-seat.js';
import { donationGiftId, giftOutputs, GIFT_TO_NETWORK } from '../../arena-protocol/src/donation-gift.js';
import { vestedShares, donationSetStands, VESTING_DAY_BLOCKS, vestedSetsNear } from '../../arena-protocol/src/donation.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { pointKey } from '../../arena-protocol/test/point-key-fixture.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const SECRET = b32(0x77), DONOR = schnorr.getPublicKey(SECRET);
const verify = (s, m, k) => schnorr.verify(s, m, k);
const NOW = 1792240000000;
const cid = (f) => createHash('sha256').update(JSON.stringify(f, (k, v) => (typeof v === 'bigint' ? String(v) : v instanceof Uint8Array ? toHex(v) : v))).digest('hex');
const fedWith = (held) => ({ status: async (o) => { const c = held.get(`${toHex(o.txid)}:${o.outIdx}`); return c ? { stored: { contractId: c } } : null; }, contractId: async (f) => cid(f) });
const heldFor = (g) => new Map(g.outputs.map((o) => [`${toHex(g.txid)}:${o.outIdx}`, cid({ paymentImage: { kind: 'hash', bytes: g.donor }, amountMsat: o.msat, claimPk: o.pk, refundPk: o.pk, expiration: 0 })]));

// the protocol developers' set in force: one entry vesting from 80 % down to 20 % over 10 days from height 1000, one plain
const NETWORK_SET = [
  { recipientPk: pointKey(0x02, 0x31), label: 'founder', shareBps: 8000, vesting: { targetBps: 2000, startHeight: 1000, days: 10 } },
  { recipientPk: pointKey(0x02, 0x32), label: 'devs', shareBps: 2000 },
];
const CENSUS = 1000 + VESTING_DAY_BLOCKS - 10;   // the lobby round's census height (a day's series shares one)
const TIP = CENSUS + 20;                          // the seat's chain tip, 20 blocks later: past the next vesting step

test('a network-set gift split at the round\'s census height is kept by a seat whose tip passed the next vesting step', async () => {
  assert.equal(donationSetStands(NETWORK_SET).ok, true, 'the set stands');
  // THE PAGE (donation-pay.js fetchDonationSet + donation-gift-page.js giftDonation): the split over the set vested at the census height
  const pageSet = vestedShares(NETWORK_SET, CENSUS);
  const totalMsat = 1000000n;
  const outs = giftOutputs({ totalMsat, recipients: pageSet }).map((o, i) => ({ outIdx: i, pk: o.pk, msat: o.msat }));
  const body = { target: GIFT_TO_NETWORK, gameDevPubkey: new Uint8Array(32), gameName: '', donor: DONOR, federationId: b32(0xfe), txid: b32(0x7a),
    totalMsat, outputs: outs, atMs: BigInt(NOW) };
  const g = { ...body, signature: schnorr.sign(donationGiftId(body), SECRET) };
  // the federation holds exactly these outputs: the donor's sats have left the wallet
  const port = fedWith(heldFor(g));
  // THE SEAT (server.js POST /donation-gift, networkSetOf): the set vested at its own chain tip
  const seatSet = vestedShares(NETWORK_SET, TIP);
  const rows = [];
  // kanban #3293: the seat also takes the sets vested a step or two below its tip (server.js networkSetOf: vestedSetsNear)
  const got = await keepDonationGift({ g, recipients: seatSet, networkSets: vestedSetsNear(NETWORK_SET, TIP), port, db: openStore(':memory:'), verify, keepRows: (r) => rows.push(...r), nowMs: NOW });
  assert.equal(got.ok, true, `the paid gift is refused by the seat, its outputs never indexed for the developers: ${got.why}`);
  assert.equal(rows.length, 2);
});

test('#3293 control: a split at a vesting step the seat\'s tip has not reached is still refused', async () => {
  const pageSet = vestedShares(NETWORK_SET, TIP + 2 * VESTING_DAY_BLOCKS);
  const totalMsat = 1000000n;
  const outs = giftOutputs({ totalMsat, recipients: pageSet }).map((o, i) => ({ outIdx: i, pk: o.pk, msat: o.msat }));
  const body = { target: GIFT_TO_NETWORK, gameDevPubkey: new Uint8Array(32), gameName: '', donor: DONOR, federationId: b32(0xfe), txid: b32(0x7b),
    totalMsat, outputs: outs, atMs: BigInt(NOW) };
  const g = { ...body, signature: schnorr.sign(donationGiftId(body), SECRET) };
  const got = await keepDonationGift({ g, recipients: vestedShares(NETWORK_SET, TIP), networkSets: vestedSetsNear(NETWORK_SET, TIP), port: fedWith(heldFor(g)), db: openStore(':memory:'), verify, keepRows: () => {}, nowMs: NOW });
  assert.equal(got.ok, false);
});
