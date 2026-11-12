// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1489 state machine audit, round 5, faucet: paidNow() writes the reward row and the report row as two separate autocommit statements.
// A faucet killed after the first (rewards.state = 'paid' committed, fsynced) and before the second leaves an approved report whose reward is paid:
// settle() reads only 'paying' rows, reject is refused for a paid reward, and nothing else moves an accepted report - the record says
// "accepted, not paid" for good (My feedback, the CSV, the admin list), while the sats went out.
// The crash is simulated as the store leaves it: the first statement of paidNow applied to the file by another connection, then the store reopened.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openFeedbackStore, FEEDBACK_KIND } from '../src/feedback-store.js';
import { eventId } from '../src/nostr-relay.js';

const hex = (b) => Buffer.from(b).toString('hex');
const key = (n) => { const secret = new Uint8Array(32).fill(n); return { secret, pubkey: hex(schnorr.getPublicKey(secret)) }; };
const report = (k) => { const e = { pubkey: k.pubkey, created_at: Math.floor(Date.now() / 1000), kind: FEEDBACK_KIND, tags: [['t', 'bug']],
  content: JSON.stringify({ happened: 'The withdraw button did nothing at all after I pressed it twice in the wallet view', expected: 'a withdrawal' }) };
  e.id = eventId(e); e.sig = hex(schnorr.sign(Buffer.from(e.id, 'hex'), k.secret)); return e; };

test('#1489 sm5-faucet-1: a crash inside paidNow leaves the reward paid and its report accepted for good', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-sm5-faucet-1-'));
  const file = join(dir, 'feedback.db');
  const HASH = 'ab'.repeat(32);
  let s = openFeedbackStore(file);
  const alice = key(7);
  const e = report(alice);
  assert.equal(s.take(e).ok, true);
  assert.equal(s.approve(e.id, 1000, { played: () => true, severity: 'low' }).ok, true);
  const k1 = s.createReward(e.id).reward.k1;
  // the claim: open -> paying; the payer's answer is not known yet (as after a 75 s lncli timeout)
  const first = await s.claim(k1, 'lntb-the-wallets-invoice', { decode: async () => ({ ok: true, amountSats: 1000, paymentHash: HASH }), pay: async () => ({ ok: false, why: 'in flight' }) });
  assert.match(first.reason, /not settled yet/);
  s.close();
  // A LATER PASS: the payment SUCCEEDED; paidNow's first statement commits (exactly its UPDATE), then the process is killed before the report's UPDATE
  const other = new DatabaseSync(file);
  other.prepare("UPDATE rewards SET state = 'paid', payment_hash = COALESCE(?, payment_hash), paid_ms = ?, why = NULL WHERE k1 = ?").run(HASH, Date.now(), k1);
  other.close();
  // RESTART: the store opened again, the settle timer runs (the payer says paid), the admin tries to tidy up
  s = openFeedbackStore(file);
  const settled = await s.settle({ status: async () => 'paid', nowMs: Date.now() + 10 * 60000 });
  const reject = s.move(e.id, 'rejected', { reason: 'tidy up' });
  const facts = { reward: s.reward(k1).state, report: s.report(e.id).state, settled, reject: reject.why || 'moved', csvRow: s.csv().split('\n')[1].split(',').slice(8, 9) };
  console.log('  MEASURED #1489 sm5-faucet-1:', JSON.stringify(facts));
  s.close();
  assert.equal(facts.reward, 'paid');
  assert.equal(facts.report, 'paid', 'the reward went out, but its report stays "accepted" and no door or timer ever moves it');
});
