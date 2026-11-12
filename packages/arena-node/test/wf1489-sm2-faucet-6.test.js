// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 sm2-faucet-6 (SM-21, accepted -> paid, and the approval limits): approve() counts a key's rewards "this week" and the week's budget by
// reports.changed_ms, which approve sets. paidNow() (claim or settle) moves changed_ms to the time of payment. So a report approved last week and
// claimed today is counted again as approved this week: three old rewards claimed today block the same player's new report for a week ("that key
// has 3 rewards this week"), and the budget bar reports sats approved last week as this week's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openFeedbackStore, FEEDBACK_KIND } from '../src/feedback-store.js';
import { eventId } from '../src/nostr-relay.js';

const hex = (b) => Buffer.from(b).toString('hex');
const DAY = 24 * 3600 * 1000;
const secret = new Uint8Array(32).fill(9), pubkey = hex(schnorr.getPublicKey(secret));
const report = (atS, n) => { const e = { pubkey, created_at: atS, kind: FEEDBACK_KIND, tags: [['t', 'bug']], content: JSON.stringify({ happened: `Report number ${n}: the lobby keeps showing a seat as free after it was taken` }) };
  e.id = eventId(e); e.sig = hex(schnorr.sign(Buffer.from(e.id, 'hex'), secret)); return e; };

test('#1489 sm2-faucet-6: a reward approved last week and claimed today does not count as approved this week', async () => {
  const fb = openFeedbackStore(':memory:');
  const T0 = Date.UTC(2026, 10, 1, 12);
  const played = () => true;
  // three reports, approved on day 0 (the key's 3 a week), each with its link
  const links = [];
  for (let i = 0; i < 3; i++) {
    const e = report(Math.floor(T0 / 1000) + i, i);
    assert.equal(fb.take(e, { nowMs: T0 + i * 1000 }).ok, true);
    assert.equal(fb.approve(e.id, 2000, { played, nowMs: T0 + 10000 + i }).ok, true);
    links.push(fb.createReward(e.id, { nowMs: T0 + 20000 + i }).reward.k1);
  }
  // day 8: the player claims all three (paid at once)
  const T8 = T0 + 8 * DAY;
  for (const k1 of links) {
    const r = await fb.claim(k1, `lntb2000x${k1}`, { decode: async () => ({ ok: true, amountSats: 2000, paymentHash: k1 }), pay: async () => ({ ok: true, paymentHash: k1 }), nowMs: T8 });
    assert.equal(r.status, 'OK');
  }
  // day 8 too: a new report of the same key
  const fresh = report(Math.floor(T8 / 1000), 9);
  assert.equal(fb.take(fresh, { nowMs: T8 + 1000 }).ok, true);
  const budget = fb.budget({ nowMs: T8 + 2000 });
  const approved = fb.approve(fresh.id, 1000, { played, nowMs: T8 + 2000 });
  const facts = { weekApprovedSats: budget.weekApprovedSats, approve: approved.ok ? 'ok' : approved.why };
  console.log('  FACTS sm2-faucet-6:', JSON.stringify(facts));
  fb.close();
  assert.equal(facts.weekApprovedSats, 0, 'nothing was approved in the last 7 days');
  assert.equal(facts.approve, 'ok', 'the key had no approval in the last 7 days');
});

test('#1786: a paid report written before the fix (changed_ms = payment time) gets its approval time back when the store opens again', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const file = join(mkdtempSync(join(tmpdir(), 'fb1786-')), 'feedback.db');
  const T0 = Date.UTC(2026, 10, 1, 12), T8 = T0 + 8 * DAY;
  let fb = openFeedbackStore(file);
  const e = report(Math.floor(T0 / 1000), 1);
  assert.equal(fb.take(e, { nowMs: T0 }).ok, true);
  assert.equal(fb.approve(e.id, 2000, { played: () => true, nowMs: T0 + 1000 }).ok, true);
  const k1 = fb.createReward(e.id, { nowMs: T0 + 2000 }).reward.k1;
  assert.equal((await fb.claim(k1, `lntb2000x${k1}`, { decode: async () => ({ ok: true, amountSats: 2000, paymentHash: k1 }), pay: async () => ({ ok: true, paymentHash: k1 }), nowMs: T8 })).status, 'OK');
  fb.close();
  // the old paidNow's row: changed_ms moved to the payment time
  const raw = new DatabaseSync(file); raw.prepare('UPDATE reports SET changed_ms = ? WHERE id = ?').run(T8, e.id); raw.close();
  fb = openFeedbackStore(file);
  const facts = { weekApprovedSats: fb.budget({ nowMs: T8 + 1000 }).weekApprovedSats };
  fb.close();
  assert.equal(facts.weekApprovedSats, 0, 'approved 8 days ago: not this week');
});
