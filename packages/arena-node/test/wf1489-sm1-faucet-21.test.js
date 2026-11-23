// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1489 sm1-faucet-21 (state machine audit, SM-22 reward link open -> paying, the amount it pays): claim() reads the reward row, then awaits
// decode() (lncli decodepayreq, up to 20 s, then `state` another 10 s), checks the invoice against the amount it READ, and takes the row open -> paying
// by a compare-and-set on the state only. In tools/faucet.mjs the LNURL callback runs in oneBounty() and the admin's `reward` action - which lowers an
// open link to the Season 2 payable amount (createReward capSats, kanban #2756) - runs in oneAdmin(): two queues. A wallet claims the link for its old
// amount, the admin's reward action lowers it meanwhile (the reporter left a community), and the claim pays the old amount while the row says paid the
// lower one: the lost bonus is paid anyway, and the pot (paidOf = the row's amount) counts less than went out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openFeedbackStore, FEEDBACK_KIND } from '../src/feedback-store.js';
import { eventId } from '../src/nostr-relay.js';

const hex = (b) => Buffer.from(b).toString('hex');
const key = (n) => { const secret = new Uint8Array(32).fill(n); return { secret, pubkey: hex(schnorr.getPublicKey(secret)) }; };

test('#1489 sm1-faucet-21: a link lowered while a claim decodes its invoice never pays the old amount', async () => {
  const s = openFeedbackStore();
  const eve = key(41);
  const e = { pubkey: eve.pubkey, created_at: Math.floor(Date.now() / 1000), kind: FEEDBACK_KIND, tags: [['t', 'bug']],
    content: JSON.stringify({ happened: 'The order button stays grey after a reload and the stake shown is the one from the round before.', expected: 'a fresh stake' }) };
  e.id = eventId(e); e.sig = hex(schnorr.sign(Buffer.from(e.id, 'hex'), eve.secret));
  assert.equal(s.take(e).ok, true);
  assert.equal(s.approve(e.id, 7500, { played: () => true, severity: 'high', rules: { mostSats: 20000 } }).ok, true);
  const k1 = s.createReward(e.id, { network: 'mainnet' }).reward.k1;
  assert.equal(s.reward(k1).amountSats, 7500);
  // the wallet read the withdraw request (7,500 sat) and sends its invoice; decodepayreq is slow
  let release; const decoded = new Promise((r) => { release = r; });
  const paidAmounts = [];
  const claiming = s.claim(k1, 'lnbc-7500', { network: 'mainnet', payer: 'p',
    decode: async () => { await decoded; return { ok: true, amountSats: 7500, paymentHash: 'aa'.repeat(32) }; },
    pay: async (inv, sats) => { paidAmounts.push(sats); return { ok: true, paymentHash: 'aa'.repeat(32) }; } });
  // meanwhile (oneAdmin, not oneBounty): the admin's reward action reads the payable amount again - the bonus is gone - and lowers the open link
  const lowered = s.createReward(e.id, { network: 'mainnet', capSats: 5000 });
  assert.equal(lowered.ok, true);
  assert.equal(s.reward(k1).amountSats, 5000, 'the open link is lowered to the payable amount');
  release();
  const out = await claiming;
  const row = s.reward(k1);
  console.log('  MEASURED sm1-faucet-21:', JSON.stringify({ claim: out, paidAmounts, rowState: row.state, rowAmountSats: row.amountSats, paidSatsOf: s.paidSatsOf(e.id) }));
  // invariant: what is paid is what the row says is paid, and never more than the link's amount at the moment it moves to paying
  for (const sats of paidAmounts) assert.ok(sats <= row.amountSats, `paid ${sats} sat on a link that says ${row.amountSats} sat`);
  s.close();
});
