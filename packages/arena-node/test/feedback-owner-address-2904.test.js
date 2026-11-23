// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #2904 (the owner 2026-11-16: "Trage die Lightning-Adresse in alle seine Reports ein"): an owner-set pay address for a player key is used only
// when the signed report names none - the report's own address always wins - and a rejected report is still never paid.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openFeedbackStore, FEEDBACK_KIND } from '../src/feedback-store.js';
import { eventId } from '../src/nostr-relay.js';

const hex = (b) => Buffer.from(b).toString('hex');
const key = (n) => { const secret = new Uint8Array(32).fill(n); return { secret, pubkey: hex(schnorr.getPublicKey(secret)) }; };
const report = (k, text, lud16 = null) => { const e = { pubkey: k.pubkey, created_at: Math.floor(Date.now() / 1000), kind: FEEDBACK_KIND, tags: [['t', 'bug'], ...(lud16 ? [['lud16', lud16]] : [])],
  content: JSON.stringify({ happened: text, expected: '', ...(lud16 ? { lnAddress: lud16 } : {}) }) };
  e.id = eventId(e); e.sig = hex(schnorr.sign(Buffer.from(e.id, 'hex'), k.secret)); return e; };

test('#2904 the report\'s own address wins; the owner address is used only when the report names none', () => {
  const s = openFeedbackStore(); const k = key(7);
  const own = report(k, 'The truck card says one parcels when a single parcel is loaded on the bed.', 'mine@wallet.example');
  const bare = report(k, 'The leaderboard sheet leaves three quarters of the screen empty on a phone.');
  s.take(own); s.take(bare);
  assert.equal(s.addressOf(bare.id), null);
  assert.equal(s.ownerAddress(k.pubkey, 'not an address').ok, false);
  assert.equal(s.ownerAddress(k.pubkey, 'owner@wallet.example', { why: 'test' }).ok, true);
  assert.equal(s.addressOf(own.id), 'mine@wallet.example', 'the signed report\'s own address wins');
  assert.equal(s.addressOf(bare.id), 'owner@wallet.example');
  assert.equal(s.ownerAddress(k.pubkey, null).ok, true); assert.equal(s.addressOf(bare.id), null);
});

test('#2904 a rejected report with an owner address is still never paid', async () => {
  const s = openFeedbackStore(); const k = key(8);
  const e = report(k, 'The settings page scrolls under the fixed top bar and shows through it.'); s.take(e);
  s.ownerAddress(k.pubkey, 'owner@wallet.example');
  assert.equal(s.approve(e.id, 1200, { played: () => true }).ok, true);
  const w = s.createReward(e.id, { network: 'mainnet' }); assert.equal(w.ok, true);
  assert.equal(s.move(e.id, 'rejected', { reason: 'not reproduced' }).ok, true);
  assert.equal(s.createReward(e.id, { network: 'mainnet' }).ok, false);
  const paid = await s.payToAddress(w.reward.k1, { invoiceFor: async () => ({ ok: true, invoice: 'lnbc_amt1200_x' }), decode: async () => ({ ok: true, amountSats: 1200, paymentHash: 'h'.repeat(64) }), pay: async () => { throw new Error('never paid'); } });
  assert.equal(paid.ok, false);
});
