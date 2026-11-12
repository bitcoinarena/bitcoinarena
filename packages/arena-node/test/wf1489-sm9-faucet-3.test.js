// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 sm9-faucet-3 (state-machine audit, SM-22 reward link): budget().openRewards - the admin page's "links not yet claimed" - counts every
// reward whose state is not 'paid', so a link voided by its report's rejection (open -> void, #1402, final: it can never pay) is still shown as money
// owed. Invariant: a void link is no unclaimed reward.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openFeedbackStore, FEEDBACK_KIND } from '../src/feedback-store.js';
import { eventId } from '../src/nostr-relay.js';

const hex = (b) => Buffer.from(b).toString('hex');
const secret = new Uint8Array(32).fill(7), pubkey = hex(schnorr.getPublicKey(secret));
const signed = (content) => { const e = { pubkey, created_at: Math.floor(Date.now() / 1000), kind: FEEDBACK_KIND, tags: [['t', 'bug']], content }; e.id = eventId(e); e.sig = hex(schnorr.sign(Buffer.from(e.id, 'hex'), secret)); return e; };

test('#1489 sm9-faucet-3: a reward link voided by a rejection is still counted as an unclaimed reward', () => {
  const s = openFeedbackStore();
  const e = signed(JSON.stringify({ happened: 'The withdraw button did nothing at all after the round ended, twice in a row.', expected: 'a withdraw' }));
  assert.equal(s.take(e).ok, true);
  assert.equal(s.approve(e.id, 2000, { played: () => true }).ok, true);
  const w = s.createReward(e.id, { network: 'mainnet' });
  assert.equal(w.ok, true);
  const before = s.budget().openRewards;
  const rej = s.move(e.id, 'rejected', { reason: 'not reproducible' });
  const after = s.budget().openRewards;
  const facts = { before, rejected: rej.ok, reward: s.reward(w.reward.k1).state, after };
  console.log('  FACTS sm9-faucet-3:', JSON.stringify(facts));
  assert.equal(s.reward(w.reward.k1).state, 'void');
  assert.deepEqual({ n: after.n, s: after.s }, { n: 0, s: 0 }, `a void link still counts as ${after.s} sat not yet claimed`);
});
