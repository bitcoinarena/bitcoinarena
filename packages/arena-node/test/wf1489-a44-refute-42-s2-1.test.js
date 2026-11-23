// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 audit44 refute of #1677, skeptic 2: THE ADDRESS PAID IS NOT THE ONE CHECKED. POST /feedback checks String(words.lnAddress) (faucet.mjs),
// so a content lnAddress sent as a JSON array ["good@wallet"] is checked as "good@wallet" - but addressOf() reads the content only when it is a string,
// and otherwise takes the signed lud16 tag, which nobody checked at send. The report's chat line says "Bounty address: good@wallet"; the reward goes to the tag.
// Safe: the address a reward pays to is the one checked at send (or none).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openFeedbackStore, FEEDBACK_KIND } from '../src/feedback-store.js';
import { eventId } from '../src/nostr-relay.js';

const hex = (b) => Buffer.from(b).toString('hex');

test('#1489-a44-s2 a content lnAddress given as an array is not swapped for the unchecked lud16 tag at payout', async () => {
  const s = openFeedbackStore();
  const secret = new Uint8Array(32).fill(9), pubkey = hex(schnorr.getPublicKey(secret));
  const words = { happened: 'The lobby shows a round as open after its entry close, and a join then fails with a refusal.', expected: '', lnAddress: ['bounty@wallet.example.com'] };
  const e = { pubkey, created_at: Math.floor(Date.now() / 1000), kind: FEEDBACK_KIND, tags: [['t', 'bug'], ['lud16', 'other@unchecked.example.net']], content: JSON.stringify(words) };
  e.id = eventId(e); e.sig = hex(schnorr.sign(Buffer.from(e.id, 'hex'), secret));
  // what faucet.mjs POST /feedback checks: `if (words.lnAddress) lnAddressWorks(words.lnAddress)` -> String() of the array
  const checkedAtSend = String(words.lnAddress).trim();
  assert.ok(s.take(e).ok, 'kept');
  const paidTo = s.addressOf(e.id);
  // and what payToAddress hands invoiceFor
  const asked = [];
  // no reward needed for addressOf; the payout passes exactly addressOf(report) to invoiceFor
  console.log('  MEASURED:', JSON.stringify({ checkedAtSend, paidTo }));
  assert.ok(paidTo === null || paidTo === checkedAtSend, `the reward goes to ${paidTo}, an address never checked (checked: ${checkedAtSend})`);
});
