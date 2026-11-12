// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1474 (Daniel 2026-11-11: "Do we have a function to give a comment when we pay?" - "1, ja. Und zeig es auch in my feedback"): a reward is paid
// straight to the Lightning address its report signed (LUD-16), with the admin's comment (LUD-12), through claim()'s one-payment guard; the comment and the
// address are kept on the reward, and a report without an address keeps its withdraw link.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openFeedbackStore, FEEDBACK_KIND, lnAddressInvoice } from '../src/feedback-store.js';
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

test('#1474 a reward goes to the report\'s Lightning address with the comment, once; the comment and address are kept', async () => {
  const s = openFeedbackStore();
  const id = approved(s, key(1), 'hexbox@hexbox-ln.example.dev');
  assert.equal(s.addressOf(id), 'hexbox@hexbox-ln.example.dev');
  const w = s.createReward(id, { network: 'mainnet', comment: '  Bitcoin Arena bounty for report #001:   request body limit - thank you ' });
  assert.equal(w.reward.comment, 'Bitcoin Arena bounty for report #001: request body limit - thank you');
  const asked = []; const P = payer();
  const invoiceFor = async (a, sats, c) => { asked.push([a, sats, c]); return { ok: true, invoice: `lnbc_amt${sats}_x` }; };
  const r = await s.payToAddress(w.reward.k1, { invoiceFor, decode: P.decode, pay: P.pay });
  assert.equal(r.ok, true, r.why);
  assert.deepEqual(asked, [['hexbox@hexbox-ln.example.dev', 5000, 'Bitcoin Arena bounty for report #001: request body limit - thank you']]);
  assert.deepEqual(P.paid, ['lnbc_amt5000_x']);
  assert.equal(s.report(id).state, 'paid');
  const kept = s.reward(w.reward.k1);
  assert.deepEqual([kept.state, kept.address, kept.comment], ['paid', 'hexbox@hexbox-ln.example.dev', 'Bitcoin Arena bounty for report #001: request body limit - thank you']);
  // never twice: a second pay, and the withdraw link, both refuse
  const again = await s.payToAddress(w.reward.k1, { invoiceFor, decode: P.decode, pay: P.pay });
  assert.equal(again.ok, false); assert.equal(P.paid.length, 1);
  assert.equal((await s.claim(w.reward.k1, 'lnbc_amt5000_y', { decode: P.decode, pay: P.pay })).status, 'ERROR');
});

test('#1474 an invoice for another amount is refused; a report without an address keeps its withdraw link, whose description carries the comment', async () => {
  const s = openFeedbackStore(); const P = payer();
  const id = approved(s, key(2), 'someone@wallet.example');
  const w = s.createReward(id, { network: 'mainnet', comment: 'thanks' });
  const wrong = await s.payToAddress(w.reward.k1, { invoiceFor: async () => ({ ok: true, invoice: 'lnbc_amt4999_x' }), decode: P.decode, pay: P.pay });
  assert.equal(wrong.ok, false); assert.equal(P.paid.length, 0); assert.equal(s.reward(w.reward.k1).state, 'open');
  const id2 = approved(s, key(3), null);
  const w2 = s.createReward(id2, { network: 'mainnet', comment: 'thanks for report #002' });
  const none = await s.payToAddress(w2.reward.k1, { invoiceFor: async () => { throw new Error('not asked'); }, decode: P.decode, pay: P.pay });
  assert.match(none.why, /names no Lightning address/);
  assert.match(s.withdrawRequest(w2.reward.k1, { base: 'https://x' }).defaultDescription, /: thanks for report #002$/);
});

test('#1474 lnAddressInvoice: LUD-16 pay request, amount in msat, the comment cut to the wallet\'s commentAllowed (none when it takes none), its bounds kept', async () => {
  const calls = [];
  // kanban #2045, #2064: a wallet's name is resolved before it is asked; these stand-in wallets answer on a public address
  const lookupFn = async () => [{ address: '93.184.215.14', family: 4 }];
  const wallet = (commentAllowed) => async (u) => { calls.push(u); const url = new URL(u);
    if (url.pathname.startsWith('/.well-known/lnurlp/')) return { ok: true, json: async () => ({ tag: 'payRequest', callback: 'https://w.example/cb', minSendable: 1000, maxSendable: 10000000, commentAllowed }) };
    return { ok: true, json: async () => ({ pr: `lnbc${url.searchParams.get('amount')}`, routes: [] }) }; };
  const r = await lnAddressInvoice('Name@W.example', 5000, 'x'.repeat(300), { lookupFn, fetchFn: wallet(200) });
  assert.deepEqual([r.ok, r.invoice, r.commentSent.length], [true, 'lnbc5000000', 200]);
  assert.equal(calls[0], 'https://w.example/.well-known/lnurlp/name');
  assert.equal(new URL(calls[1]).searchParams.get('comment').length, 200);
  calls.length = 0; const n = await lnAddressInvoice('name@w.example', 5000, 'hello', { lookupFn, fetchFn: wallet(0) });
  assert.equal(n.commentSent, ''); assert.equal(new URL(calls[1]).searchParams.has('comment'), false);
  const big = await lnAddressInvoice('name@w.example', 20000, '', { lookupFn, fetchFn: wallet(10) });
  assert.match(big.why, /takes 1 to 10000 sat/);
});
