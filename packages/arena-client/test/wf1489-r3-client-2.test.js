// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 round 3: ONE SEAT'S /donations ANSWER MUST NOT BLOCK A ZAP / REFERRAL COLLECT. collectZaps keeps the FIRST seat's row per
// outpoint (found.has(outpoint) -> skip): a seat that answers first with the real outpoint and a changed amountMsat (or playerKey) has its
// version refunded, the federation refuses it ("another contract at that outpoint"), and the honest seats' correct row is never tried -
// every minute, for as long as that seat answers first. Safe: every version of an outpoint is tried until one is collected.
import test from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '../../arena-node/node_modules/@noble/curves/secp256k1.js';
import { collectZaps } from '../src/identity.js';
import { identitySecretFor } from '../../arena-protocol/src/player-key.js';
import { refundKeyOf } from '../../arena-protocol/src/stake-lock.js';
import { fromHex, toHex } from '../../arena-protocol/src/hash.js';

const curve = { pointX: (sk) => schnorr.getPublicKey(sk), signSchnorr: (m, sk) => schnorr.sign(m, sk) };
const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
const SEED = 'ab'.repeat(32);
const F = 'fe'.repeat(32);
const TXID = 'cd'.repeat(32);
const DONOR = 'aa'.repeat(32);

test('a zap stays collectable when one seat answers first with a changed amount for its outpoint', async () => {
  const s = mem(); s.setItem('arena.player.seed', SEED);
  const pk = toHex(refundKeyOf(schnorr.getPublicKey(identitySecretFor(fromHex(SEED)))));
  const real = { outpoint: `${TXID}:0`, federationId: F, amountMsat: '21000', senderOnContract: true, playerKey: DONOR };
  const forged = { ...real, amountMsat: '1' };
  // the bad seat answers at once, the honest seats a moment later
  const fetcher = async (u) => {
    if (u.startsWith('https://bad.example')) return new Response(JSON.stringify({ donations: [forged] }), { status: 200 });
    await new Promise((r) => setTimeout(r, 20));
    return new Response(JSON.stringify({ donations: [real] }), { status: 200 });
  };
  // the federation: the contract at the outpoint is the real one; any other fields are refused as the lock client does
  const client = { refund: async (txid, outIdx, fields) => {
    const f = JSON.parse(fields);
    if (f.amountMsat !== real.amountMsat || f.paymentImage.bytes !== DONOR || f.refundPk !== pk) throw new Error('the guardians hold another contract at that outpoint than this lock\'s');
    return JSON.stringify({ accepted: true });
  } };
  const got = await collectZaps({ storage: s, keep: mem(), curve, clients: new Map([[F, client]]),
    seats: ['https://bad.example', 'https://a.example', 'https://b.example', 'https://c.example'], fetcher });
  console.log(`  collected ${got.collected.length}, failed ${got.failed.length}: ${got.failed.map((x) => x.why).join('; ')}`);
  assert.equal(got.collected.length, 1, 'the honest seats\' row for the same outpoint is collected');
  assert.equal(got.totalMsat, '21000');
});
