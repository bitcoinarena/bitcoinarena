// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A PLAYER'S OWN REFERRAL LINK (kanban #681, 2026-10-26: "Add user support for referrer program, not just websites. A user may also use a
// referrer code and link to testnet.bitcoin-arena.io. He gets 10% of the node's income"): the program's key is the player's identity refund
// key (02 and the identity key); an entry names it as its website key, the settlement's website share is paid to it as to a node's program,
// a seat keeps its name signed by the identity key, and the player's page collects the payout into its wallet with the identity secret - and
// writes a history row for it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { referralOf, referralNameFor, tabIdentity, collectZaps } from '../../arena-client/src/identity.js';
import { recordReceived, ledgerRows, ledgerHistory } from '../../arena-client/src/page-lock.js';
import { frontendShares, FRONTEND_FEE_PERCENT } from '../../arena-protocol/src/fee.js';
import { DELIVERED } from '../../arena-protocol/src/payout.js';
import { identitySecretFor } from '../../arena-protocol/src/player-key.js';
import { keepReferralName, referralNames } from '../src/referral-names.js';
import { openStore } from '../src/store.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const curve = { pointX: (sk) => schnorr.getPublicKey(sk), signSchnorr: (m, sk) => schnorr.sign(m, sk) };
const verify = (s, m, k) => schnorr.verify(s, m, k);
const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
const SEED = '5e'.repeat(32);
const storage = () => { const s = mem(); s.setItem('arena.player.seed', SEED); return s; };
const noSeed = () => { throw new Error('no wallet'); };

test('the link: the identity refund key, made again from the same 24 words, no seed minted for it', () => {
  const me = referralOf({ storage: storage(), random: noSeed, curve, origin: 'https://testnet.bitcoin-arena.io/' });
  assert.equal(me.key, '02' + tabIdentity({ storage: storage(), curve }).pubkeyHex);
  assert.equal(me.link, `https://testnet.bitcoin-arena.io/?ref=${me.key}`);
  assert.match(me.link.split('?ref=')[1], /^0[23][0-9a-f]{64}$/, 'the page\'s ?ref= rule takes it');
  assert.deepEqual(referralOf({ storage: storage(), random: noSeed, curve }), { key: me.key, link: `/?ref=${me.key}` });
  assert.throws(() => referralOf({ storage: mem(), random: noSeed, curve }), /no wallet/);
});

test('an entry names it as its website key and the settlement pays it the website share, as a node\'s program', () => {
  const me = referralOf({ storage: storage(), random: noSeed, curve });
  const site = fromHex('03' + 'ab'.repeat(32));
  const entries = [{ outcome: DELIVERED, stakeMsat: 100000n, frontendPk: fromHex(me.key) }, { outcome: DELIVERED, stakeMsat: 100000n, frontendPk: site },
    { outcome: DELIVERED, stakeMsat: 200000n }];
  const got = frontendShares({ entries, fee: 8000n, gross: 400000n });
  assert.deepEqual([...got.shares.entries()].map(([k, v]) => [k, String(v)]), [[me.key, String(8000n * FRONTEND_FEE_PERCENT / 100n / 4n)], [toHex(site), '200']]);
  assert.equal(FRONTEND_FEE_PERCENT, 10n);
});

test('its name, signed by the identity key, is kept by a seat as a node\'s program\'s is; a newer one replaces it', () => {
  const me = referralOf({ storage: storage(), random: noSeed, curve });
  const db = openStore(':memory:');
  const now = Date.now();
  assert.deepEqual(keepReferralName(db, referralNameFor({ name: 'brave-otter-0042', storage: storage(), random: noSeed, curve, nowMs: now - 5000 }), { verify, nowMs: now }),
    { ok: true, kept: 'new', site: me.key, name: 'brave-otter-0042' });
  assert.equal(keepReferralName(db, referralNameFor({ name: 'satoshi', storage: storage(), random: noSeed, curve, nowMs: now - 1000 }), { verify, nowMs: now }).kept, 'new');
  assert.equal(referralNames(db).get(me.key).name, 'satoshi');
  // another wallet cannot name this one
  const other = mem(); other.setItem('arena.player.seed', '77'.repeat(32));
  const forged = referralNameFor({ name: 'thief', storage: other, random: noSeed, curve, nowMs: now });
  const rec = forged.record.slice(0, 2) + me.key + forged.record.slice(68);
  assert.equal(keepReferralName(db, { record: rec, signature: forged.signature }, { verify, nowMs: now }).ok, false);
  assert.throws(() => referralNameFor({ name: ' ', storage: storage(), random: noSeed, curve }), /printable characters/);
});

test('the page collects the referral payout into its wallet with the identity secret, says the total, and writes a history row', async () => {
  const s = storage(), keep = mem(), ledger = mem();
  const pk = referralOf({ storage: s, random: noSeed, curve }).key;
  const F = 'fe'.repeat(32), R = '91'.repeat(32);
  const rows = [{ outpoint: `${'c1'.repeat(32)}:2`, federationId: F, roundId: R, amountMsat: '800', senderOnContract: false, playerKey: null, item: 'website' },
    { outpoint: `${'c2'.repeat(32)}:0`, federationId: 'aa'.repeat(32), roundId: R, amountMsat: '300', senderOnContract: false, playerKey: null, item: 'website' },
    { outpoint: `${'c3'.repeat(32)}:0`, federationId: F, roundId: '00'.repeat(32), amountMsat: '21000', senderOnContract: true, playerKey: '0b'.repeat(32), item: 'zap' }];
  const fetcher = async (u) => { assert.ok(u.endsWith(`/donations?key=${pk}&since=0`)); return new Response(JSON.stringify({ donations: rows }), { status: 200 }); };
  const refunds = [];
  const client = { refund: async (txid, outIdx, fields, secretHex) => { refunds.push({ txid, outIdx, fields: JSON.parse(fields), secretHex }); return JSON.stringify({ accepted: true }); } };
  const got = await collectZaps({ storage: s, keep, curve, clients: new Map([[F, client]]), seats: ['https://a.example'], fetcher });
  assert.deepEqual(got.referral, { msat: '1100', payouts: 2 }, 'every website payout the seats list, collected or waiting for a wallet there');
  assert.deepEqual(got.collected.map((c) => [c.item, c.amountMsat, c.roundId]), [['website', '800', R], ['zap', '21000', '00'.repeat(32)]]);
  assert.deepEqual(refunds[0], { txid: 'c1'.repeat(32), outIdx: 2, secretHex: toHex(identitySecretFor(fromHex(SEED))),
    fields: { paymentImage: { kind: 'hash', bytes: '00'.repeat(32) }, amountMsat: '800', claimPk: pk, refundPk: pk, expiration: 0 } });
  for (const c of got.collected) recordReceived(ledger, c.federationId, { kind: c.item === 'website' ? 'referral' : 'zap-in', msat: c.amountMsat, round: c.item === 'website' ? c.roundId : null, outpoint: c.outpoint });
  recordReceived(ledger, F, { kind: 'stake', msat: '1' });
  assert.deepEqual(ledgerHistory(ledgerRows(ledger, F)).map((r) => [r.kind, r.msat, r.round]), [['referral', '800', R], ['zap-in', '21000', null]], 'only the two kinds');
});
