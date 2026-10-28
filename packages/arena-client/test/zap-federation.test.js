// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A ZAP FROM THE SEASON BOARD IS E-CASH IN THE FEDERATION (2026-10-17: "zaps in the leaderboard go to the federation's
// account of the user not an external lightning payment, remove the configuration setting"): the sender's wallet pays one payout
// contract to the player's identity refund key, the record names the player and no set, the seats' rule takes it, and the player's
// own page finds it on the seats and spends it into its wallet with the identity secret - once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { zapPlayer } from '../src/donation-gift-page.js';
import { collectZaps, tabIdentity, ZAPS_COLLECTED_KEY } from '../src/identity.js';
import { decodeDonationGift, encodeDonationGift, donationGiftId, giftStands, playerGiftRecipients, GIFT_TO_PLAYER } from '../../arena-protocol/src/donation-gift.js';
import { refundKeyOf } from '../../arena-protocol/src/stake-lock.js';
import { identitySecretFor } from '../../arena-protocol/src/player-key.js';
import { fromHex, toHex } from '../../arena-protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const SECRET = b32(0x77), donor = { pubkey: schnorr.getPublicKey(SECRET), sign: (m) => schnorr.sign(m, SECRET) };
const verify = (s, m, k) => schnorr.verify(s, m, k);
const TXID = 'cd'.repeat(32);
const curve = { pointX: (sk) => schnorr.getPublicKey(sk), signSchnorr: (m, sk) => schnorr.sign(m, sk) };
const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
const SEED = 'ab'.repeat(32);
const storage = () => { const s = mem(); s.setItem('arena.player.seed', SEED); return s; };

test('the zap: one output of the whole amount to the player\'s identity refund key, a record that names the player and that the seats\' rule takes', async () => {
  const player = tabIdentity({ storage: storage(), curve }).pubkey;
  const paid = [], posted = [];
  const wallet = { paySubmit: async (j) => { paid.push(JSON.parse(j)); return JSON.stringify({ txid: TXID }); },
    lockAccepted: async () => JSON.stringify({ donations: paid[0].map((o, i) => ({ out_idx: i, recipient_pk: o.pk, amount_msat: o.msat, ids_match: true })) }) };
  const fetch = async (u, o) => { posted.push(JSON.parse(o.body)); return new Response('{}', { status: 200 }); };
  const got = await zapPlayer({ player, sat: 21, wallet, federationId: 'fe'.repeat(32), donor, seats: ['https://s.example'], fetch, nowMs: () => 1792240000000 });
  assert.deepEqual([got.ok, got.sat, got.outputs], [true, 21, 1]);
  assert.deepEqual(paid[0], [{ pk: toHex(refundKeyOf(player)), msat: '21000', image: toHex(donor.pubkey) }]);
  const g = { ...decodeDonationGift(fromHex(posted[0].gift)), signature: fromHex(posted[0].signature) };
  assert.deepEqual([g.target, toHex(g.gameDevPubkey), g.gameName, g.totalMsat], [GIFT_TO_PLAYER, toHex(player), '', 21000n]);
  assert.deepEqual(giftStands(g, { recipients: playerGiftRecipients(g.gameDevPubkey), verify, nowMs: 1792240000000 }), { ok: true, id: donationGiftId(g) });
  // a zap names a player and no game
  assert.throws(() => encodeDonationGift({ ...g, gameDevPubkey: b32(0) }), /32-byte identity key/);
  assert.throws(() => encodeDonationGift({ ...g, gameName: 'nextblock' }), /and no game/);
});

test('the player\'s page collects what was sent to its identity key into its wallet, with the identity secret, once', async () => {
  const s = storage(), keep = mem();
  const secret = identitySecretFor(fromHex(SEED));
  const pk = toHex(refundKeyOf(schnorr.getPublicKey(secret)));
  const F = 'fe'.repeat(32);
  const rows = [{ outpoint: `${TXID}:0`, federationId: F, amountMsat: '21000', senderOnContract: true, playerKey: toHex(donor.pubkey) },
    { outpoint: `${'ef'.repeat(32)}:0`, federationId: 'aa'.repeat(32), amountMsat: '5000', senderOnContract: true, playerKey: toHex(donor.pubkey) }];
  const asked = [];
  const fetcher = async (u) => { asked.push(u); return new Response(JSON.stringify({ donations: rows }), { status: 200 }); };
  const refunds = [];
  const client = { refund: async (txid, outIdx, fields, secretHex) => { refunds.push({ txid, outIdx, fields: JSON.parse(fields), secretHex }); return JSON.stringify({ accepted: true, txid: 'f0'.repeat(32) }); } };
  const got = await collectZaps({ storage: s, keep, curve, clients: new Map([[F, client]]), seats: ['https://a.example', 'https://b.example/'], fetcher });
  assert.equal(got.key, pk);
  assert.ok(asked.every((u) => u.endsWith(`/donations?key=${pk}&since=0`)) && asked.length === 2);
  assert.deepEqual([got.collected.length, got.waiting.length, got.totalMsat], [1, 1, '21000'], 'the other federation waits for a wallet there');
  assert.deepEqual(refunds[0], { txid: TXID, outIdx: 0, secretHex: toHex(secret),
    fields: { paymentImage: { kind: 'hash', bytes: toHex(donor.pubkey) }, amountMsat: '21000', claimPk: pk, refundPk: pk, expiration: 0 } });
  assert.deepEqual(JSON.parse(keep.getItem(ZAPS_COLLECTED_KEY)), [`${TXID}:0`]);
  const again = await collectZaps({ storage: s, keep, curve, clients: new Map([[F, client]]), seats: ['https://a.example'], fetcher });
  assert.deepEqual([again.collected.length, refunds.length], [0, 1], 'collected once');
  // a contract already spent (by this key, the only one that can) is final, not retried
  const spentClient = { refund: async () => JSON.stringify({ accepted: false, stored_before: null }) };
  const k2 = mem();
  const sp = await collectZaps({ storage: s, keep: k2, curve, clients: new Map([[F, spentClient]]), seats: ['https://a.example'], fetcher });
  assert.deepEqual([sp.spent.length, JSON.parse(k2.getItem(ZAPS_COLLECTED_KEY)).length], [1, 1]);
  void secp256k1;
});
