// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #3265 (the owner 2026-11-21: play at once from the game URL with an empty new wallet): a run opens before its entry is paid; it is scored and
// placed only when the 100-sat invoice settles before the run's deadline.
import test from 'node:test';
import assert from 'node:assert/strict';
import { world, openRound, keypair, logOf, MIN } from './server-helpers.mjs';

test('#3265 POST /attempt opens the run at once: level, provisional token, invoice; check says pending-entry', async () => {
  const w = world({ start: '2026-11-23T01:00:00Z' }); const r = await openRound(w); const p = keypair();
  const s = await w.opr.startAttempt(p.pk, { round: r.id });
  assert.equal(s.state, 'pending-entry'); assert.match(s.token, /^[0-9a-f]{64}$/); assert.match(s.invoice, /^lntb/);
  assert.equal(s.level.candles.length, 48); assert.equal(s.deadlineMs - s.startedMs, 10 * MIN);
  assert.equal(s.expiresMs, s.startedMs + 30000);   // #3603: the invoice lives 30 s - the entry is paid first
  const c = await w.opr.checkAttempt(p.pk, s.attempt);
  assert.equal(c.state, 'pending-entry'); assert.equal(c.token, s.token); assert.equal(c.paid, false);
  w.lnd.pay(s.invoice);
  assert.equal((await w.opr.checkAttempt(p.pk, s.attempt)).state, 'started');
});

test('#3265 an unpaid run is never on the board and not in the pot; at its deadline it is "entry not paid"', async () => {
  const w = world({ start: '2026-11-23T01:00:00Z' }); const r = await openRound(w); const p = keypair();
  const s = await w.opr.startAttempt(p.pk, { round: r.id });
  w.clock.add(20000);   // #3603: sent inside the entry's 30 s, still unpaid
  const sub = await w.opr.submitChecked(p.pk, { attempt: s.attempt, token: s.token, log: logOf(9) });
  assert.equal(sub.ok, true); assert.equal(sub.paid, false); assert.equal(sub.state, 'pending-entry'); assert.equal(sub.score.total, 90);
  assert.deepEqual(w.opr.boardOf(r.id), []); assert.equal(w.opr.potOf(r.id), 0);
  assert.equal((await w.opr.checkAttempt(p.pk, s.attempt)).state, 'pending-entry');
  w.clock.add(10 * MIN); await w.opr.tick();
  const c = await w.opr.checkAttempt(p.pk, s.attempt);
  assert.equal(c.state, 'entry-not-paid'); assert.match(c.why, /does not count/);
  assert.deepEqual(w.opr.boardOf(r.id), []); assert.equal(w.opr.potOf(r.id), 0);
  // an unsubmitted unpaid run ends the same way; a submit after it is refused
  const s2 = await w.opr.startAttempt(p.pk, { round: r.id });
  w.clock.add(10 * MIN + 1); await w.opr.tick();
  assert.equal((await w.opr.checkAttempt(p.pk, s2.attempt)).state, 'entry-not-paid');
  assert.match(w.opr.submit(p.pk, { attempt: s2.attempt, token: s2.token, log: logOf(3) }).why, /entry not paid/);
});

// #3603: a payment AFTER the submit no longer scores a run (server-pay-first-3603.test.js); one settled before the submit that lnd showed only
// after it still does
test('#3265 a run whose entry settled before its submit, seen only after it, is scored and placed - on the tick, or on the next check', async () => {
  const w = world({ start: '2026-11-23T01:00:00Z' }); const r = await openRound(w);
  const p = keypair(), q = keypair();
  const a = await w.opr.startAttempt(p.pk, { round: r.id });
  const b = await w.opr.startAttempt(q.pk, { round: r.id });
  const t0 = w.clock.now();
  w.clock.add(20000);
  assert.equal(w.opr.submit(p.pk, { attempt: a.attempt, token: a.token, log: logOf(7) }).paid, false);
  assert.equal(w.opr.submit(q.pk, { attempt: b.attempt, token: b.token, log: logOf(5) }).paid, false);
  w.lnd.pay(a.invoice); w.lnd.pay(b.invoice);
  for (const x of w.lnd.inv.values()) if (x.state === 'SETTLED') x.settleMs = t0 + 15000;
  w.clock.add(1000);
  await w.opr.tick();
  assert.deepEqual(w.opr.boardOf(r.id).map((x) => [x.player, x.total]), [[p.pk, 70], [q.pk, 50]]);
  assert.equal(w.opr.potOf(r.id), 200);
  assert.equal((await w.opr.checkAttempt(p.pk, a.attempt)).state, 'scored');
});

test('#3265 a run paid before the submit is scored at once; the submit reads lnd first', async () => {
  const w = world({ start: '2026-11-23T01:00:00Z' }); const r = await openRound(w); const p = keypair();
  const a = await w.opr.startAttempt(p.pk, { round: r.id });
  w.lnd.pay(a.invoice);   // paid in the background, no check or tick since
  w.clock.add(60000);
  const sub = await w.opr.submitChecked(p.pk, { attempt: a.attempt, token: a.token, log: logOf(4) });
  assert.equal(sub.paid, true); assert.equal(sub.state, 'scored');
  assert.deepEqual(w.opr.boardOf(r.id).map((x) => x.total), [40]);
});

test('#3265 an entry settled after the deadline does not count (lnd settle time)', async () => {
  const w = world({ start: '2026-11-23T01:00:00Z' }); const r = await openRound(w); const p = keypair();
  const a = await w.opr.startAttempt(p.pk, { round: r.id });
  w.clock.add(60000);
  await w.opr.submitChecked(p.pk, { attempt: a.attempt, token: a.token, log: logOf(6) });
  w.lnd.pay(a.invoice); [...w.lnd.inv.values()][0].settleMs = a.deadlineMs + 60000;
  w.clock.set(a.deadlineMs + 61000); await w.opr.tick();
  assert.equal((await w.opr.checkAttempt(p.pk, a.attempt)).state, 'entry-not-paid');
  assert.deepEqual(w.opr.boardOf(r.id), []); assert.equal(w.opr.potOf(r.id), 0);
});

test('#3265 every opened run counts toward the 5 for the whole round, paid or not; pot = 100 x paid', async () => {
  const w = world({ start: '2026-11-23T01:00:00Z' }); const r = await openRound(w); const p = keypair();
  const runs = [];
  for (let i = 0; i < 5; i++) { const s = await w.opr.startAttempt(p.pk, { round: r.id }); assert.equal(s.ok, true); runs.push(s); }
  assert.equal((await w.opr.startAttempt(p.pk, { round: r.id })).why, 'all 5 attempts of this round are used');
  w.lnd.pay(runs[0].invoice); w.lnd.pay(runs[1].invoice);
  w.clock.add(10 * MIN + 1); await w.opr.tick();
  assert.equal(w.opr.potOf(r.id), 200);
  assert.equal((await w.opr.checkAttempt(p.pk, runs[4].attempt)).state, 'entry-not-paid');
  // the 3 never-paid runs still count, hours later: a 6th run is refused
  w.clock.add(5 * 60 * MIN); await w.opr.tick();
  const sixth = await w.opr.startAttempt(p.pk, { round: r.id });
  assert.equal(sixth.ok, false); assert.equal(sixth.why, 'all 5 attempts of this round are used');
  assert.equal(w.opr.publicRound(w.opr.roundRow(r.id)).potSats, 200);
});

test('#3265 five runs never paid: no 6th run, nothing in the pot, nothing on the board', async () => {
  const w = world({ start: '2026-11-23T01:00:00Z' }); const r = await openRound(w); const p = keypair();
  for (let i = 0; i < 5; i++) { const s = await w.opr.startAttempt(p.pk, { round: r.id }); w.clock.add(60000); await w.opr.submitChecked(p.pk, { attempt: s.attempt, token: s.token, log: logOf(5 + i) }); }
  w.clock.add(60 * MIN); await w.opr.tick();
  assert.equal((await w.opr.startAttempt(p.pk, { round: r.id })).why, 'all 5 attempts of this round are used');
  assert.equal(w.opr.potOf(r.id), 0); assert.deepEqual(w.opr.boardOf(r.id), []);
});

test('#3265 every rejection rule holds for a pending-entry run', async () => {
  const w = world({ start: '2026-11-23T01:00:00Z' }); const r = await openRound(w); const p = keypair();
  const a = await w.opr.startAttempt(p.pk, { round: r.id });
  w.clock.add(1000);
  assert.match(w.opr.submit(p.pk, { attempt: a.attempt, token: a.token, log: logOf(12) }).why, /faster than/);
  assert.equal(w.opr.submit(p.pk, { attempt: a.attempt, token: a.token, log: logOf(12) }).why, 'that token was used already');
  const b = await w.opr.startAttempt(p.pk, { round: r.id }); w.clock.add(60000);
  assert.equal(w.opr.submit(keypair().pk, { attempt: b.attempt, token: b.token, log: logOf(3) }).why, 'that token is not yours');
  assert.equal(w.opr.submit(p.pk, { attempt: b.attempt, token: b.token, round: 'x', log: logOf(3) }).why, 'that token is of another round');
  assert.match(w.opr.submit(p.pk, { attempt: b.attempt, token: b.token, log: logOf(3, 'opr-0') }).why, /wrong game version/);
  const c = await w.opr.startAttempt(p.pk, { round: r.id }); w.clock.add(60000);
  assert.match(w.opr.submit(p.pk, { attempt: c.attempt, token: c.token, log: { v: 'opr-test-1', presses: [[5, 3]] } }).why, /malformed/);
  // a refused run whose entry is paid later is in the pot, never on the board
  w.lnd.pay(a.invoice); await w.opr.tick();
  assert.equal(w.opr.potOf(r.id), 100); assert.deepEqual(w.opr.boardOf(r.id), []);
});
