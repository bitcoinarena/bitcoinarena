// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #2786 (feedback #083; the owner 2026-11-15 "Keine Auszahlungen"): the owner withdraws an open reward link (void-reward: open -> void,
// its LNURL refuses, the row stays); My feedback hands out a link only while it can pay, so a withdrawn link is never shown claimable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openFeedbackStore, FEEDBACK_KIND } from '../src/feedback-store.js';
import { eventId } from '../src/nostr-relay.js';

const hex = (b) => Buffer.from(b).toString('hex');
const key = (n) => { const secret = new Uint8Array(32).fill(n); return { secret, pubkey: hex(schnorr.getPublicKey(secret)) }; };
const report = (k, lud16) => { const e = { pubkey: k.pubkey, created_at: Math.floor(Date.now() / 1000), kind: FEEDBACK_KIND,
  tags: [['t', 'bug'], ['game', 'rock-paper-scissors'], ...(lud16 ? [['lud16', lud16]] : [])],
  content: JSON.stringify({ happened: 'The node reads a request body with no size limit, so one large POST fills its memory before any check.', expected: '', ...(lud16 ? { lnAddress: lud16 } : {}) }) };
  e.id = eventId(e); e.sig = hex(schnorr.sign(Buffer.from(e.id, 'hex'), k.secret)); return e; };
const approved = (s, k, lud16, sats = 5000) => { const e = report(k, lud16); s.take(e); assert.equal(s.approve(e.id, sats, { played: () => true }).ok, true); return e.id; };
// a payer that pays every invoice once and remembers it
const payer = () => { const paid = []; return { paid, decode: async (inv) => ({ ok: true, amountSats: Number(/amt(\d+)/.exec(inv)[1]), paymentHash: 'h'.repeat(64) }),
  pay: async (inv) => { paid.push(inv); return { ok: true, paymentHash: 'h'.repeat(64) }; } }; };

test('#2786 void-reward: an open link is withdrawn once, its LNURL refuses, the row and the report stay; paid links are not touched', async () => {
  const s = openFeedbackStore();
  const id = approved(s, key(3), null, 500);
  const w = s.createReward(id, { network: 'mainnet' });
  assert.equal(s.withdrawRequest(w.reward.k1, { base: 'https://x' }).tag, 'withdrawRequest');
  const v = s.voidReward(id, { why: 'no payouts for now', by: 'owner' });
  assert.equal(v.ok, true, v.why); assert.equal(v.made, true);
  assert.deepEqual([v.reward.k1, v.reward.state, v.reward.why], [w.reward.k1, 'void', 'no payouts for now']);
  assert.equal(s.withdrawRequest(w.reward.k1, { base: 'https://x' }).status, 'ERROR');
  assert.equal(s.report(id).state, 'accepted');
  assert.ok(s.moves(id).some((m) => /reward link withdrawn, 500 sat on mainnet: no payouts for now/.test(m.note || '')));
  assert.equal(s.voidReward(id).made, false);   // twice: the same void row
  assert.equal(s.voidReward('nope').ok, false);
  const id2 = approved(s, key(4), null, 700);
  assert.equal(s.voidReward(id2).ok, false);    // no link yet
  // a paid link stays paid
  const id3 = approved(s, key(5), 'a@b.example.dev', 600);
  const w3 = s.createReward(id3, { network: 'mainnet' });
  const P = payer();
  assert.equal((await s.payToAddress(w3.reward.k1, { invoiceFor: async (a, sats) => ({ ok: true, invoice: `lnbc_amt${sats}_x` }), decode: P.decode, pay: P.pay })).ok, true);
  const v3 = s.voidReward(id3); assert.equal(v3.ok, false); assert.match(v3.why, /paid/);
  assert.equal(s.reward(w3.reward.k1).state, 'paid');
});

test('#2786 faucet: the admin has void-reward, and My feedback gives an lnurl only for an open link', () => {
  const src = readFileSync(new URL('../tools/faucet.mjs', import.meta.url), 'utf8');
  assert.match(src, /b\.action === 'void-reward'\) return send\(200, FEEDBACK\.voidReward\(/);
  const mine = src.slice(src.indexOf("if (path === '/feedback/mine')"), src.indexOf("if (path === '/feedback')"));
  assert.match(mine, /lnurl: w\.state !== 'open' \? null : FEEDBACK\.lnurlOf/);
});

test('#2786 a withdrawn link of an approved report is made again once, at the amount payable now; the old LNURL stays dead', async () => {
  const s = openFeedbackStore();
  const id = approved(s, key(7), null, 1000);
  const w = s.createReward(id, { network: 'mainnet' });
  assert.equal(s.voidReward(id).ok, true);
  const again = s.createReward(id, { network: 'mainnet', capSats: 150, comment: 'Season 2: 15 %' });
  assert.equal(again.ok, true, again.why); assert.equal(again.made, true);
  assert.notEqual(again.reward.k1, w.reward.k1);
  assert.deepEqual([again.reward.state, again.reward.amountSats, again.reward.comment], ['open', 150, 'Season 2: 15 %']);
  assert.equal(s.withdrawRequest(w.reward.k1, { base: 'https://x' }).status, 'ERROR', 'the old k1 is gone');
  assert.equal(s.withdrawRequest(again.reward.k1, { base: 'https://x' }).tag, 'withdrawRequest');
  const third = s.createReward(id, { network: 'mainnet', capSats: 150 });
  assert.equal(third.made, false); assert.equal(third.reward.k1, again.reward.k1, 'a second call makes nothing new');
  assert.ok(s.moves(id).some((m) => /reward link made again after its withdrawal, 150 sat on mainnet/.test(m.note || '')));
});
  assert.equal(s.move(id2, 'rejected', { reason: 'no' }).ok, true);
  const r2 = s.createReward(id2, { network: 'mainnet' }); assert.notEqual(r2.made, true);
});
