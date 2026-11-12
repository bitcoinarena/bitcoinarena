// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1489 sm1-faucet-12 (state machine audit, SM-21 accepted -> paid x SM-22 reward link, after #1784): a reward link is paid only on the network it
// was made for, so after the payout switch (testnet4 -> mainnet, 2026-11-11) an approved report whose link was made on testnet4 and not yet claimed
// can never be paid: claim, payToAddress and the withdraw request refuse it ("made on testnet4"), and createReward - the admin's "reward" action,
// asked again with the mainnet network - answers the same testnet4 link (one reward per report, made once). The report stays `accepted` with an open
// link for good; the only way out is `reject`, which tells the player their report was rejected. For a node bounty that `accepted` row also holds
// the node's one bounty and one of the first NODE_BOUNTY_MOST places for ever, so the node is never paid its mainnet bounty.
// Invariant: an accepted report can reach `paid` (its reward is payable on the faucet's payout network), or leaves `accepted` by a move that says why.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { eventId } from '../src/nostr-relay.js';
import { openFeedbackStore, FEEDBACK_KIND } from '../src/feedback-store.js';

const hex = (b) => Buffer.from(b).toString('hex');
const key = (n) => { const secret = new Uint8Array(32).fill(n); return { secret, pubkey: hex(schnorr.getPublicKey(secret)) }; };
const signed = (k, tags, content) => { const e = { pubkey: k.pubkey, created_at: Math.floor(Date.now() / 1000), kind: FEEDBACK_KIND, tags, content };
  e.id = eventId(e); e.sig = hex(schnorr.sign(Buffer.from(e.id, 'hex'), k.secret)); return e; };

test('#1489 sm1-faucet-12: an approved node bounty whose link was made on testnet4 can be paid after the payout network moved to mainnet', async () => {
  const s = openFeedbackStore(':memory:');
  const owner = key(7), node = 'ab'.repeat(32);
  const e = signed(owner, [['t', 'bug'], ['source', 'node'], ['node', node]], JSON.stringify({ happened: 'My node shows the bond as posted but the census page lists it as missing since this morning.', expected: 'listed', lnAddress: 'me@wallet.example.com' }));
  assert.equal(s.take(e).ok, true);
  assert.equal(s.approve(e.id, null, { severity: 'node', played: () => true }).ok, true);
  // before the switch: the admin made the link on testnet4 (FAUCET_BOUNTY_NETWORK=testnet4); nobody claimed it yet
  const before = s.createReward(e.id, { network: 'testnet4' });
  assert.equal(before.ok, true);
  // after the switch (FAUCET_BOUNTY_NETWORK=mainnet): the admin's "reward" action again, and the player's claim
  const after = s.createReward(e.id, { network: 'mainnet' });
  const req = s.withdrawRequest(after.reward.k1, { base: 'https://x.example/api/faucet', network: 'mainnet' });
  const paid = [];
  const toAddress = await s.payToAddress(after.reward.k1, { network: 'mainnet', invoiceFor: async () => ({ ok: true, invoice: 'lnbc10000n1x' }),
    decode: async () => ({ ok: true, amountSats: 10000, paymentHash: 'cd'.repeat(32) }), pay: async (i) => { paid.push(i); return { ok: true, paymentHash: 'cd'.repeat(32) }; } });
  const report = s.report(e.id);
  console.log('  MEASURED #1489 sm1-faucet-12:', JSON.stringify({ rewardNetwork: after.reward.network, made: after.made, withdraw: req.status || req.tag, reason: req.reason || null,
    payToAddress: toAddress.ok ? 'paid' : toAddress.why, report: report.state, nodeBountyHeld: s.nodeBountyFor(report) }));
  assert.ok(toAddress.ok || req.tag === 'withdrawRequest', `the approved report is ${report.state} with a ${after.reward.network} link the mainnet payout refuses (${req.reason}); asked again, createReward answered that same link - it can never be paid`);
});
