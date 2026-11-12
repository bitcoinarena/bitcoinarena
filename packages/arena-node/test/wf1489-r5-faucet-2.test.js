// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 round 5 (faucet): THE BOUNTY PAYOUT FETCHES ADDRESSES NOBODY CHECKED. #1511 refused an internal host in lnAddressWorks, the check made
// when a report is sent - but the payout (admin "Pay to address", lnAddressInvoice) has no such guard: neither for the address it is given nor for the
// callback URL the wallet's answer names. And the address paid is addressOf(): the report's signed `lud16` TAG first, which POST /feedback never checks
// (it checks only the content's lnAddress). A reporter signs a working content address and a lud16 tag naming an internal host, or a public address
// whose payRequest names an internal callback: when the reward is paid, the faucet's own process fetches that internal URL (P2, a bypass of #1511).
// Safe: the payout never fetches an IP literal, localhost or a local-only name - neither the address nor its callback - and the address a reward pays
// to is one that was checked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openFeedbackStore, FEEDBACK_KIND, lnAddressInvoice, lnAddressWorks } from '../src/feedback-store.js';
import { eventId } from '../src/nostr-relay.js';

const hex = (b) => Buffer.from(b).toString('hex');
const recorder = (answers) => { const asked = []; return { asked, fetchFn: async (u) => { asked.push(String(u)); const host = new URL(u).hostname;
  const body = answers(host, String(u)); return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }); } }; };
const internal = (u) => /^(127\.|10\.|192\.168\.|localhost$|\[)/.test(new URL(u).hostname);

test('#1489-r5 lnAddressInvoice never fetches an internal host given as the address', async () => {
  const r = recorder(() => ({ tag: 'payRequest', callback: 'https://wallet.example.com/cb', minSendable: 1000, maxSendable: 1e9 }));
  const out = await lnAddressInvoice('bounty@127.0.0.1', 1000, '', { fetchFn: r.fetchFn });
  console.log('  MEASURED address:', JSON.stringify({ asked: r.asked, out }));
  assert.equal(r.asked.filter(internal).length, 0, 'no fetch to 127.0.0.1');
});

test('#1489-r5 a public address whose payRequest names an internal callback: the callback is never fetched', async () => {
  const r = recorder((host) => (host === 'wallet.example.com' ? { tag: 'payRequest', callback: 'https://127.0.0.1:8443/admin/act', minSendable: 1000, maxSendable: 1e9 } : { pr: 'lnbc10u1xyz' }));
  const works = await lnAddressWorks('bounty@wallet.example.com', { fetchFn: r.fetchFn });
  const out = await lnAddressInvoice('bounty@wallet.example.com', 1000, '', { fetchFn: r.fetchFn });
  console.log('  MEASURED callback:', JSON.stringify({ works, asked: r.asked, out }));
  assert.equal(r.asked.filter(internal).length, 0, 'no fetch to the internal callback');
});

test('#1489-r5 the address a reward pays to is not an unchecked lud16 tag naming an internal host', () => {
  const s = openFeedbackStore();
  const secret = new Uint8Array(32).fill(7), pubkey = hex(schnorr.getPublicKey(secret));
  const e = { pubkey, created_at: Math.floor(Date.now() / 1000), kind: FEEDBACK_KIND, tags: [['t', 'bug'], ['lud16', 'x@127.0.0.1']],
    content: JSON.stringify({ happened: 'The lobby shows a round as open after its entry close, and a join then fails with a refusal.', expected: '', lnAddress: 'bounty@wallet.example.com' }) };
  e.id = eventId(e); e.sig = hex(schnorr.sign(Buffer.from(e.id, 'hex'), secret));
  assert.equal(s.take(e).ok, true);
  const a = s.addressOf(e.id);
  console.log('  MEASURED addressOf:', JSON.stringify({ checkedAtSend: 'bounty@wallet.example.com', paidTo: a }));
  assert.notEqual(a, 'x@127.0.0.1', 'the unchecked internal lud16 tag is not where the reward is paid');
});
