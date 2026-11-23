// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2803 (audit r21 client-1): ONE SEAT BOOKS A MADE-UP /donations ROW AS COLLECTED THROUGH THE 'BEGUN' MARK. Pass 1: the seat lists a
// made-up outpoint with an amount past u64 - the lock client cannot parse it and throws, the 'collecting' mark stays. Pass 2: the same outpoint
// with any amount, item 'website': the refund finds no contract (stored_before null), the mark says "begun here" and the row is booked as a
// collected Referral of the seat's own amount. Safe: only a refund of the same version counts as begun; nothing made up is booked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '../../arena-node/node_modules/@noble/curves/secp256k1.js';
import { collectZaps } from '../src/identity.js';

const curve = { pointX: (sk) => schnorr.getPublicKey(sk), signSchnorr: (m, sk) => schnorr.sign(m, sk) };
const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };

test('#2803 a made-up /donations row is never booked as collected through an earlier pass\'s mark', async () => {
  const F = 'aa'.repeat(32), OUT = `${'ef'.repeat(32)}:0`;
  let row = { outpoint: OUT, federationId: F, amountMsat: '99999999999999999999', item: 'website' };
  const fetcher = async () => new Response(JSON.stringify({ donations: [row] }), { status: 200 });
  const store = mem(); store.setItem('arena.player.seed', 'ab'.repeat(32));
  const keep = mem();
  // the lock client: u64 amounts only, and no contract at this outpoint
  const client = { refund: async (txid, vout, fields) => { const a = JSON.parse(fields).amountMsat; if (BigInt(a) > 0xffffffffffffffffn) throw new Error('number too large to fit in target type'); return JSON.stringify({ accepted: false, stored_before: null }); } };
  const p1 = await collectZaps({ storage: store, keep, curve, clients: new Map([[F, client]]), seats: ['https://liar.example'], fetcher });
  row = { outpoint: OUT, federationId: F, amountMsat: '5000000000000', item: 'website' };
  const p2 = await collectZaps({ storage: store, keep, curve, clients: new Map([[F, client]]), seats: ['https://liar.example'], fetcher });
  console.log('  MEASURED:', JSON.stringify({ p1: { collected: p1.collected.length, failed: p1.failed.length }, p2: { collected: p2.collected.length, spent: p2.spent.length }, referral: p2.referral }));
  assert.equal(p2.collected.length, 0, `the made-up row was booked as collected: ${JSON.stringify(p2.collected)} (referral ${p2.referral.msat} msat)`);
  assert.equal(p2.referral.msat, '0');
});
