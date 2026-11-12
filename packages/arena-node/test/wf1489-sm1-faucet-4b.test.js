// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1489 sm1-faucet-4 (state machine audit, SM-22 reward link + its `address` column, kanban #1474): payToAddress() writes the report's
// Lightning address on the reward row BEFORE claim() pays. When that payment fails for sure (no route), the link is open again with the address
// still written. The admin falls back to the withdraw link (tools/faucet.mjs answers it beside the failed `paid`), the player's own wallet claims it,
// and the paid row - shown in "My feedback" and the admin list as "paid to <address>" - names an address that never received a sat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openFeedbackStore, FEEDBACK_KIND } from '../src/feedback-store.js';
import { eventId } from '../src/nostr-relay.js';

const hex = (b) => Buffer.from(b).toString('hex');
const key = (n) => { const secret = new Uint8Array(32).fill(n); return { secret, pubkey: hex(schnorr.getPublicKey(secret)) }; };

test('#1489 sm1-faucet-4: a reward paid through its withdraw link does not name the Lightning address that was never paid', async () => {
  const s = openFeedbackStore();
  const alice = key(3);
  const e = { pubkey: alice.pubkey, created_at: Math.floor(Date.now() / 1000), kind: FEEDBACK_KIND, tags: [['t', 'bug'], ['lud16', 'alice@wallet.example']],
    content: JSON.stringify({ happened: 'The deposit spinner never stops. Steps: opened the lobby, joined a round, watched the screen.', expected: 'a balance' }) };
  e.id = eventId(e); e.sig = hex(schnorr.sign(Buffer.from(e.id, 'hex'), alice.secret));
  assert.equal(s.take(e).ok, true);
  assert.equal(s.approve(e.id, 1000, { played: () => true }).ok, true);
  const k1 = s.createReward(e.id).reward.k1;
  const decode = async (inv) => ({ ok: true, amountSats: 1000, paymentHash: `h-${inv}` });
  // the address gives an invoice, the route fails for sure: the link is open again
  const viaAddress = await s.payToAddress(k1, { invoiceFor: async () => ({ ok: true, invoice: 'addr-invoice' }), decode, pay: async () => ({ ok: false, failed: true, why: 'NO_ROUTE' }) });
  const between = s.reward(k1);
  // the withdraw link, claimed by the player's own wallet with its own invoice: paid
  const viaLink = await s.claim(k1, 'wallet-invoice', { decode, pay: async () => ({ ok: true, paymentHash: 'h-wallet-invoice' }) });
  const end = s.reward(k1);
  console.log('  MEASURED #1489 sm1-faucet-4:', JSON.stringify({ viaAddress: viaAddress.why, between: [between.state, between.address], viaLink: viaLink.status, end: [end.state, end.address, end.paymentHash] }));
  assert.equal(viaAddress.ok, false);
  assert.equal(viaLink.status, 'OK');
  assert.equal(end.state, 'paid');
  assert.equal(end.address, null, 'the paid reward names alice@wallet.example, which got nothing: it was paid through the withdraw link');
});
