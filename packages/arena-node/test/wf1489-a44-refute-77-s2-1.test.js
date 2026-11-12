// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 a44-refute-77-s2 (fix #1786, the reload path): the repair at store open sets a paid report's changed_ms to MAX(at_ms) of its
// report_moves with to_state = 'accepted'. But createReward() ("reward link made") and note() also write a move to_state = 'accepted' for an
// accepted report. The repair runs on EVERY open, so a report approved on day 0, whose link was made (or which got a ticket note) on day 6 and
// was claimed then, has its approval time moved to day 6 at the next restart: on day 8 it counts as approved this week again - the #1786 bug,
// through the restart instead of through paidNow.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openFeedbackStore, FEEDBACK_KIND } from '../src/feedback-store.js';
import { eventId } from '../src/nostr-relay.js';

const hex = (b) => Buffer.from(b).toString('hex');
const DAY = 24 * 3600 * 1000;
const secret = new Uint8Array(32).fill(7), pubkey = hex(schnorr.getPublicKey(secret));
const report = (atS, n) => { const e = { pubkey, created_at: atS, kind: FEEDBACK_KIND, tags: [['t', 'bug']], content: JSON.stringify({ happened: `Report number ${n}: the lobby keeps showing a seat as free after it was taken` }) };
  e.id = eventId(e); e.sig = hex(schnorr.sign(Buffer.from(e.id, 'hex'), secret)); return e; };
const payOk = (k1) => ({ decode: async () => ({ ok: true, amountSats: 2000, paymentHash: k1 }), pay: async () => ({ ok: true, paymentHash: k1 }) });

async function scenario(late) {
  const file = join(mkdtempSync(join(tmpdir(), 'a44r77-')), 'feedback.db');
  const T0 = Date.UTC(2026, 10, 1, 12), T6 = T0 + 6 * DAY, T8 = T0 + 8 * DAY;
  const played = () => true;
  let fb = openFeedbackStore(file);
  for (let i = 0; i < 3; i++) {
    const e = report(Math.floor(T0 / 1000) + i, i);
    assert.equal(fb.take(e, { nowMs: T0 + i }).ok, true);
    assert.equal(fb.approve(e.id, 2000, { played, nowMs: T0 + 1000 + i }).ok, true);   // approved on day 0
    let k1;
    if (late === 'link') k1 = fb.createReward(e.id, { nowMs: T6 + i, by: 'admin' }).reward.k1;   // the link is made on day 6
    else { k1 = fb.createReward(e.id, { nowMs: T0 + 2000 + i }).reward.k1; assert.equal(fb.note(e.id, { ticket: '#42', nowMs: T6 + i, by: 'admin' }).ok, true); }   // a ticket note on day 6
    assert.equal((await fb.claim(k1, `lntb2000x${k1}`, { ...payOk(k1), nowMs: T6 + 10 + i })).status, 'OK');
  }
  const before = fb.budget({ nowMs: T8 }).weekApprovedSats;
  fb.close();
  fb = openFeedbackStore(file);   // a restart (deploy, reboot) on day 8
  const fresh = report(Math.floor(T8 / 1000), 9);
  assert.equal(fb.take(fresh, { nowMs: T8 + 1 }).ok, true);
  const after = fb.budget({ nowMs: T8 + 2 }).weekApprovedSats;
  const a = fb.approve(fresh.id, 1000, { played, nowMs: T8 + 3 });
  fb.close();
  const facts = { late, weekBeforeRestart: before, weekAfterRestart: after, approve: a.ok ? 'ok' : a.why };
  console.log('  FACTS a44-refute-77-s2:', JSON.stringify(facts));
  return facts;
}

test('#1489 a44-refute-77-s2: a link made days after approval does not move the approval time at the next restart', async () => {
  const f = await scenario('link');
  assert.equal(f.weekBeforeRestart, 0, 'approved 8 days ago: not this week (before the restart)');
  assert.equal(f.weekAfterRestart, 0, 'approved 8 days ago: still not this week after the restart');
  assert.equal(f.approve, 'ok', 'the key had no approval in the last 7 days');
});

test('#1489 a44-refute-77-s2: a ticket note days after approval does not move the approval time at the next restart', async () => {
  const f = await scenario('note');
  assert.equal(f.weekBeforeRestart, 0);
  assert.equal(f.weekAfterRestart, 0, 'approved 8 days ago: still not this week after the restart');
  assert.equal(f.approve, 'ok', 'the key had no approval in the last 7 days');
});
