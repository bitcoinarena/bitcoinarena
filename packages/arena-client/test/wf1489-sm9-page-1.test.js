// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #1489 sm9 page-1: PAID, RECORD NOT KEPT, BOUGHT AGAIN. buyItem pays first and hands the signed record to the seats after; when no seat keeps it
// (every seat 503 for a moment) it answers { ok:false, step:'record', retry } and keeps that record nowhere: the page drops `retry` and says
// "Not bought (record)". The player presses Buy again: a second payment for the same item, and the first one's outputs are named by no record.
// Invariant: one item, one payment - a purchase whose payment the federation accepted is never paid again; its record is handed again instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '../../arena-node/node_modules/@noble/curves/secp256k1.js';
import { buyItem } from '../src/item-buy.js';
import { giftDonation } from '../src/donation-gift-page.js';
import { signFinalSig } from '../../arena-protocol/src/final-sig.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const pk33 = (n) => Uint8Array.from([0x02, ...schnorr.getPublicKey(b32(n))]);   // on 1.9 a set key must be a real point (an even-y x-only key, 02-prefixed)
const verify = (s, m, k) => schnorr.verify(s, m, k);
const NOW = 1792090683000;
const NODES = [b32(0x31), b32(0x32), b32(0x33)];
const NODE_KEYS = NODES.map((s) => schnorr.getPublicKey(s));
const MANIFEST = { gameDevPubkey: b32(0xde), gameName: 'nextblock', items: [{ id: 'large-truck', name: 'Larger truck', priceSat: 500n, unlock: b32(0xa1) }], requiredProtocolVersion: 10 };
const NET = [{ recipientPk: pk33(0x11), label: 'dev a', shareBps: 6667 }, { recipientPk: pk33(0x12), label: 'dev b', shareBps: 3333 }];
const BUYER = b32(0x77);
const player = { pubkey: schnorr.getPublicKey(BUYER), sign: (d) => schnorr.sign(d, BUYER) };
const ROUND = b32(0x5a);
const finals = NODES.map((s) => signFinalSig({ roundId: ROUND, entryId: b32(1), runId: b32(2), signerPubkey: schnorr.getPublicKey(s), signedAtMs: BigInt(NOW - 3600000) }, (d) => schnorr.sign(d, s)));

// seats that refuse every record until `up` is set, then keep it
function seats() {
  const st = { up: false, kept: [] };
  st.fetch = async (url, o = {}) => {
    if (url.includes('/served?')) return { ok: true, json: async () => ({ held: [{ roundId: toHex(ROUND), committee: NODE_KEYS.map(toHex), finals: finals.map(toHex) }] }) };
    if (url.endsWith('/item-purchase') || url.endsWith('/donation-gift')) {
      if (!st.up) return { ok: false, status: 503, text: async () => 'restarting' };
      st.kept.push(JSON.parse(o.body)); return { ok: true, status: 201, text: async () => 'kept' };
    }
    throw new Error(`no such door ${url}`);
  };
  return st;
}
// a wallet that counts what it paid
function wallet() {
  const w = { paid: 0, payments: 0 };
  w.paySubmit = async (json) => { const outs = JSON.parse(json); w.payments++; w.paid += outs.reduce((t, o) => t + Number(o.msat), 0);
    return JSON.stringify({ txid: String(w.payments).padStart(2, '0').repeat(32), outputs: outs.map((o, i) => ({ out_idx: i, amount_msat: o.msat, recipient_pk: o.pk })), payouts: outs }); };
  w.lockAccepted = async (s) => { const j = JSON.parse(s); return JSON.stringify({ donations: j.outputs.map((o) => ({ ...o, ids_match: true })) }); };
  return w;
}
const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } }; };

test('an item paid whose record no seat kept is not paid again when the player presses Buy once more', async () => {
  const s = seats(); const w = wallet();
  const ask = { manifest: MANIFEST, itemId: 'large-truck', networkSet: NET, gameSet: NET, wallet: w, federationId: 'fe'.repeat(32), player,
    seats: ['https://s1', 'https://s2'], fetch: s.fetch, verify, nowMs: () => NOW };
  const first = await buyItem(ask);
  assert.deepEqual([first.ok, first.step], [false, 'record'], 'paid, the record not kept');
  assert.equal(w.payments, 1);
  // the seats are back; the page shows "Not bought (record): ..." and the player buys again
  s.up = true;
  const again = await buyItem(ask);
  assert.equal(again.ok, true, again.why);
  assert.equal(w.payments, 1, `the item was paid ${w.payments} times (${w.paid} msat for one ${MANIFEST.items[0].priceSat} sat item): the first payment's record was kept nowhere, so the retry paid again`);
  assert.equal(s.kept.length, 2);   // on 1.9 the record goes to every seat, kept when two keep it (#2420): each of the two seats kept it once
});

test('a developer gift paid whose record no seat kept is not paid again on the next press', async () => {
  const s = seats(); const w = wallet();
  const ask = { recipients: NET, sat: 1000, wallet: w, federationId: 'fe'.repeat(32), donor: player, seats: ['https://s1'], fetch: s.fetch, storage: mem(), nowMs: () => NOW };
  const first = await giftDonation(ask);
  assert.deepEqual([first.ok, first.step], [false, 'record']);
  s.up = true;
  const again = await giftDonation(ask);
  assert.equal(again.ok, true, again.why);
  assert.equal(w.payments, 1, `the gift was paid ${w.payments} times for one press that failed at its record`);
});
