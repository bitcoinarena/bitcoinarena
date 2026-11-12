// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 sm4-faucet-3 (state machine, SM-22 reward link): a reward's payment is identified by its payment hash only, and nothing keeps one
// hash to one reward. Reward X is paid with invoice I. Reward Y (same amount) is then claimed with the same, already paid invoice I: lnd refuses
// ("invoice is already paid", no FAILED line), so Y stays paying, and settle() reads the bounty wallet's record of that hash - SUCCEEDED, X's
// payment - and books Y paid. Y's report is paid and its link gone while no sat moved for it: the record lies about an effect, and the budget's
// "paid" counts sats that were never sent. Invariant: a paid reward has its own payment (no two paid rewards share a payment hash).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openFeedbackStore, FEEDBACK_KIND } from '../src/feedback-store.js';
import { eventId } from '../src/nostr-relay.js';

const hex = (b) => Buffer.from(b).toString('hex');
const key = (n) => { const secret = new Uint8Array(32).fill(n); return { secret, pubkey: hex(schnorr.getPublicKey(secret)) }; };
const report = (k, words) => { const e = { pubkey: k.pubkey, created_at: Math.floor(Date.now() / 1000), kind: FEEDBACK_KIND, tags: [['t', 'bug'], ['game', 'rock-paper-scissors']],
  content: JSON.stringify({ happened: words, expected: '' }) };
  e.id = eventId(e); e.sig = hex(schnorr.sign(Buffer.from(e.id, 'hex'), k.secret)); return e; };

test('sm4-faucet-3: a reward claimed with an invoice another reward was already paid with is never booked paid', async () => {
  const s = openFeedbackStore();
  const k = key(7), t0 = Date.now();
  const ids = ['The lobby shows a round as open after it settled, so a tap there joins nothing and the stake waits.',
    'The wallet strip says 0 sat for a few seconds after a reload although the notes are there and spendable.'].map((w) => { const e = report(k, w); s.take(e); assert.equal(s.approve(e.id, 5000, { played: () => true }).ok, true); return e.id; });
  const [X, Y] = ids.map((id) => s.createReward(id, { network: 'mainnet' }).reward.k1);
  // the bounty wallet: pays a hash once; a second payinvoice of a paid hash is refused as lnd does (no "Payment status: FAILED")
  const wallet = new Map();
  const HASH = '9f'.repeat(32);
  const decode = async () => ({ ok: true, amountSats: 5000, paymentHash: HASH });
  const pay = async () => { if (wallet.get(HASH) === 'SUCCEEDED') return { ok: false, why: 'in flight' }; wallet.set(HASH, 'SUCCEEDED'); return { ok: true, paymentHash: HASH }; };
  const status = async (h) => (wallet.get(h) === 'SUCCEEDED' ? 'paid' : 'failed');
  assert.equal((await s.claim(X, 'lnbc50u1invoice', { decode, pay, nowMs: t0 })).status, 'OK');
  const y = await s.claim(Y, 'lnbc50u1invoice', { decode, pay, nowMs: t0 + 1000 });
  await s.settle({ status, nowMs: t0 + 1000 + 200000 });
  const rewards = s.rewards().map((w) => ({ report: w.report === ids[0] ? 'X' : 'Y', state: w.state, hash: w.paymentHash && w.paymentHash.slice(0, 8) }));
  const paidRewards = rewards.filter((w) => w.state === 'paid');
  console.log('  MEASURED sm4-faucet-3:', JSON.stringify({ claimY: y, rewards, reportY: s.report(ids[1]).state, paymentsMade: wallet.size }));
  assert.equal(wallet.size, 1);
  assert.equal(paidRewards.length, 1, 'one payment, one paid reward: Y was never paid');
  assert.notEqual(s.report(ids[1]).state, 'paid');
});

// kanban #1925: a file from before the fix may already hold a paid reward and a paying one on one hash (no unique index could be made on it): the store
// still opens, and settle() credits the hash only to the reward that has it paid - the other link opens again, its report stays approved
test('sm4-faucet-3 (#1925): an older file with two rewards on one hash - settle books only the first paid', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const file = join(mkdtempSync(join(tmpdir(), 'fb1925-')), 'fb.db');
  const raw = new DatabaseSync(file);
  raw.exec(`CREATE TABLE reports (id TEXT PRIMARY KEY, pubkey TEXT NOT NULL, type TEXT NOT NULL, signed_at INTEGER NOT NULL, received_ms INTEGER NOT NULL,
      happened TEXT NOT NULL, expected TEXT NOT NULL, game TEXT, round TEXT, build TEXT, event TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'new', reason TEXT, duplicate_of TEXT, severity TEXT, amount_sats INTEGER, ticket TEXT, changed_ms INTEGER);
    CREATE TABLE rewards (k1 TEXT PRIMARY KEY, report TEXT NOT NULL UNIQUE, pubkey TEXT NOT NULL, amount_sats INTEGER NOT NULL, network TEXT NOT NULL,
      created_ms INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'open', invoice TEXT, payment_hash TEXT, tried_ms INTEGER, paid_ms INTEGER, why TEXT);`);
  const t0 = Date.now(), H = 'ab'.repeat(32), pk = 'cd'.repeat(32);
  for (const [id, st] of [['a'.repeat(64), 'paid'], ['b'.repeat(64), 'accepted']])
    raw.prepare("INSERT INTO reports (id, pubkey, type, signed_at, received_ms, happened, expected, event, state, amount_sats, changed_ms) VALUES (?, ?, 'bug', ?, ?, 'x', '', '{}', ?, 5000, ?)").run(id, pk, Math.floor(t0 / 1000), t0, st, t0);
  raw.prepare("INSERT INTO rewards (k1, report, pubkey, amount_sats, network, created_ms, state, invoice, payment_hash, tried_ms, paid_ms) VALUES ('kx', ?, ?, 5000, 'mainnet', ?, 'paid', 'i', ?, ?, ?)").run('a'.repeat(64), pk, t0, H, t0, t0);
  raw.prepare("INSERT INTO rewards (k1, report, pubkey, amount_sats, network, created_ms, state, invoice, payment_hash, tried_ms) VALUES ('ky', ?, ?, 5000, 'mainnet', ?, 'paying', 'i', ?, ?)").run('b'.repeat(64), pk, t0, H, t0 + 1000);
  raw.close();
  const s = openFeedbackStore(file);
  const out = await s.settle({ status: async () => 'paid', nowMs: t0 + 400000 });
  const by = Object.fromEntries(s.rewards().map((w) => [w.k1, w.state]));
  console.log('  MEASURED sm4-faucet-3 older file:', JSON.stringify({ out, by, reportY: s.report('b'.repeat(64)).state }));
  assert.deepEqual(by, { kx: 'paid', ky: 'open' });
  assert.equal(s.report('b'.repeat(64)).state, 'accepted');
});
