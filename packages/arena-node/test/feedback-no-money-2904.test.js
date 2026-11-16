// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #2904 (the owner 2026-11-16: eight rejected reports read "1,200 sat approved" in the admin list): a rejected or duplicate report holds no
// amount, gets no reward link and is never paid - the move clears its amount and voids an open link in one step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openFeedbackStore, FEEDBACK_KIND } from '../src/feedback-store.js';
import { eventId } from '../src/nostr-relay.js';

const hex = (b) => Buffer.from(b).toString('hex');
const key = (n) => { const secret = new Uint8Array(32).fill(n); return { secret, pubkey: hex(schnorr.getPublicKey(secret)) }; };
const report = (k, text) => { const e = { pubkey: k.pubkey, created_at: Math.floor(Date.now() / 1000), kind: FEEDBACK_KIND, tags: [['t', 'bug'], ['lud16', 'p@wallet.example']],
  content: JSON.stringify({ happened: text, expected: '', lnAddress: 'p@wallet.example' }) };
  e.id = eventId(e); e.sig = hex(schnorr.sign(Buffer.from(e.id, 'hex'), k.secret)); return e; };
const P = { decode: async () => ({ ok: true, amountSats: 1200, paymentHash: 'h'.repeat(64) }), pay: async () => { throw new Error('never paid'); } };
const invoiceFor = async () => ({ ok: true, invoice: 'lnbc_amt1200_x' });

test('#2904 rejecting an approved report clears its amount, voids its link, and no link or payout follows', async () => {
  const s = openFeedbackStore();
  const e = report(key(1), 'The order book shows a price that the book cannot fill at all, for every window.'); s.take(e);
  assert.equal(s.approve(e.id, 1200, { played: () => true }).ok, true);
  const w = s.createReward(e.id, { network: 'mainnet' }); assert.equal(w.ok, true);
  const out = s.move(e.id, 'rejected', { reason: 'not reproduced' });
  assert.equal(out.ok, true);
  assert.equal(out.report.amountSats, null, 'no amount left on a rejected report');
  assert.equal(s.reward(w.reward.k1).state, 'void');
  const again = s.createReward(e.id, { network: 'mainnet' });
  assert.equal(again.ok, false); assert.match(again.why, /rejected report gets no reward/);
  const paid = await s.payToAddress(w.reward.k1, { invoiceFor, ...P });
  assert.equal(paid.ok, false);
});

test('#2904 a duplicate holds no amount and gets no reward link', () => {
  const s = openFeedbackStore();
  const a = report(key(2), 'First: the lobby lists a round that already closed and PLAY joins nothing.'); s.take(a);
  const b = report(key(3), 'Second: the lobby lists a round that already closed and PLAY joins nothing, again.'); s.take(b);
  const out = s.move(b.id, 'duplicate', { duplicateOf: a.id });
  assert.equal(out.ok, true, out.why); assert.equal(out.report.amountSats, null);
  const w = s.createReward(b.id, { network: 'mainnet' });
  assert.equal(w.ok, false); assert.match(w.why, /duplicate report gets no reward/);
});
