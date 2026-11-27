// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #3603 (feedback #437): a pending-entry run (#3265) could be paid after its score was known - submit moved an unpaid run to 'awaiting' with its
// score, and settle() scored it whenever the invoice settled before the deadline, so a player paid only for runs that beat the board. Now a
// paid entry must settle first: within entryPayMs (30 s) of the run's start and before its submit; the invoice lives only that long, and a run
// sent before its entry settled is never scored by a later payment. Free rounds unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { world, openRound, keypair, logOf, MIN } from './server-helpers.mjs';

const payAt = (w, invoice, ms) => { w.lnd.pay(invoice); const x = [...w.lnd.inv.values()].find((v) => v.state === 'SETTLED' && !v.settleMs); x.settleMs = ms; };

test('#3603 the entry invoice lives 30 s, not the run\'s 10 minutes', async () => {
  const w = world({ start: '2026-11-23T01:00:00Z' }); const r = await openRound(w); const p = keypair();
  const s = await w.opr.startAttempt(p.pk, { round: r.id });
  assert.equal(s.deadlineMs - s.startedMs, 10 * MIN);
  assert.equal(s.expiresMs - s.startedMs, 30000);
  assert.equal([...w.lnd.inv.values()].at(-1).expirySeconds, 30);
});

test('#3603 a run sent before its entry settled is never scored by a later payment', async () => {
  const w = world({ start: '2026-11-23T01:00:00Z' }); const r = await openRound(w); const p = keypair();
  const s = await w.opr.startAttempt(p.pk, { round: r.id });
  w.clock.add(20000);
  const sub = await w.opr.submitChecked(p.pk, { attempt: s.attempt, token: s.token, log: logOf(3) });
  assert.equal(sub.ok, true); assert.equal(sub.paid, false);
  payAt(w, s.invoice, w.clock.now() + 3000);   // the score is known: paid 3 s after the submit, still inside the 30 s
  w.clock.add(5000); await w.opr.tick();
  assert.notEqual((await w.opr.checkAttempt(p.pk, s.attempt)).state, 'scored');
  assert.deepEqual(w.opr.boardOf(r.id), [], 'a run paid after its score was known is on the board');
});

test('#3603 the bad-run attack: play, read the score, pay only if it beats the board - never ranked', async () => {
  const w = world({ start: '2026-11-23T01:00:00Z' }); const r = await openRound(w); const p = keypair();
  const s = await w.opr.startAttempt(p.pk, { round: r.id });
  w.clock.add(2 * MIN);
  await w.opr.submitChecked(p.pk, { attempt: s.attempt, token: s.token, log: logOf(9) });
  payAt(w, s.invoice, w.clock.now() + 1000);
  w.clock.add(2000); await w.opr.tick();
  assert.deepEqual(w.opr.boardOf(r.id), []);
  assert.notEqual((await w.opr.checkAttempt(p.pk, s.attempt)).state, 'scored');
});

test('#3603 an entry not settled 30 s after the start is "entry not paid" at once, and the run is refused', async () => {
  const w = world({ start: '2026-11-23T01:00:00Z' }); const r = await openRound(w); const p = keypair();
  const s = await w.opr.startAttempt(p.pk, { round: r.id });
  w.clock.add(36000); await w.opr.tick();
  const c = await w.opr.checkAttempt(p.pk, s.attempt);
  assert.equal(c.state, 'entry-not-paid');
  w.clock.add(60000);
  const sub = await w.opr.submitChecked(p.pk, { attempt: s.attempt, token: s.token, log: logOf(9) });
  assert.equal(sub.ok, false); assert.match(sub.why, /entry not paid/);
  assert.equal(w.opr.potOf(r.id), 0);
});

test('#3603 the honest flow: paid within 30 s, played, sent - scored and placed', async () => {
  const w = world({ start: '2026-11-23T01:00:00Z' }); const r = await openRound(w); const p = keypair();
  const s = await w.opr.startAttempt(p.pk, { round: r.id });
  payAt(w, s.invoice, w.clock.now() + 12000);
  w.clock.add(3 * MIN);
  const sub = await w.opr.submitChecked(p.pk, { attempt: s.attempt, token: s.token, log: logOf(6) });
  assert.equal(sub.paid, true); assert.equal(sub.state, 'scored');
  assert.deepEqual(w.opr.boardOf(r.id).map((x) => x.total), [60]); assert.equal(w.opr.potOf(r.id), 100);
});

test('#3603 free rounds unchanged: started and paid at once, scored on submit', async () => {
  const w = world({ start: '2026-11-23T01:00:00Z', cfg: { entrySats: 0 } }); const r = await openRound(w); const p = keypair();
  const s = await w.opr.startAttempt(p.pk, { round: r.id });
  assert.equal(s.state, 'started'); assert.equal(s.free, true);
  w.clock.add(5 * MIN);
  const sub = await w.opr.submitChecked(p.pk, { attempt: s.attempt, token: s.token, log: logOf(5) });
  assert.equal(sub.paid, true); assert.equal(sub.state, 'scored');
  assert.deepEqual(w.opr.boardOf(r.id).map((x) => x.total), [50]);
});
