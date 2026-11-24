// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #3248: paid attempts, 5 a round, the 10-minute window, the last 5 minutes, the pot.
import test from 'node:test';
import assert from 'node:assert/strict';
import { world, openRound, paidAttempt, keypair, logOf, at, MIN } from './server-helpers.mjs';

test('#3248 a 6th attempt is refused; an unpaid run of the 5 holds its place until its deadline', async () => {
  const w = world({ start: '2026-11-23T01:00:00Z' });
  const r = await openRound(w);
  const p = keypair();
  for (let i = 0; i < 4; i++) { const a = await paidAttempt(w, p.pk, r.id); assert.equal(a.state, 'started'); }
  const fifth = await w.opr.startAttempt(p.pk, { round: r.id });
  assert.equal(fifth.ok, true); assert.equal(fifth.state, 'pending-entry');
  const sixth = await w.opr.startAttempt(p.pk, { round: r.id });   // the unpaid fifth counts (#3265)
  assert.equal(sixth.ok, false); assert.equal(sixth.why, 'all 5 attempts of this round are used');
  w.lnd.pay(fifth.invoice); await w.opr.checkAttempt(p.pk, fifth.attempt);
  assert.equal((await w.opr.startAttempt(p.pk, { round: r.id })).why, 'all 5 attempts of this round are used');
  assert.equal(w.lnd.inv.size, 5);
  // another player is not counted against this one
  assert.equal((await w.opr.startAttempt(keypair().pk, { round: r.id })).ok, true);
});

test('#3248 an underpaid entry never pays the run; an unknown token is refused', async () => {
  const w = world({ start: '2026-11-23T01:00:00Z' });
  const r = await openRound(w);
  const p = keypair();
  const s = await w.opr.startAttempt(p.pk, { round: r.id });
  assert.equal(w.lnd.inv.get([...w.lnd.inv.keys()][0]).sats, 100);
  assert.equal(w.opr.submit(p.pk, { attempt: s.attempt, token: '', log: logOf(3) }).why, 'unknown token');
  w.lnd.pay(s.invoice, 99000);   // 99 sat
  let c = await w.opr.checkAttempt(p.pk, s.attempt);
  assert.equal(c.state, 'pending-entry'); assert.equal(c.paid, false);
  assert.equal(w.opr.potOf(r.id), 0);
  w.clock.add(12 * MIN); await w.opr.tick();
  c = await w.opr.checkAttempt(p.pk, s.attempt);
  assert.equal(c.state, 'entry-not-paid');   // 99 of 100 sat: never paid, never counted
  assert.equal(w.opr.potOf(r.id), 0);
  // someone else's attempt id is not yours
  assert.equal((await w.opr.checkAttempt(keypair().pk, s.attempt)).ok, false);
});

test('#3248 the pot is 100 x the started attempts (a started one counts even unsubmitted)', async () => {
  const w = world({ start: '2026-11-23T01:00:00Z' });
  const r = await openRound(w);
  const ps = [keypair(), keypair(), keypair()];
  let started = 0;
  for (const [i, p] of ps.entries()) for (let k = 0; k <= i; k++) { await paidAttempt(w, p.pk, r.id); started++; }
  await w.opr.startAttempt(keypair().pk, { round: r.id });   // invoiced, never paid
  assert.equal(started, 6);
  assert.equal(w.opr.potOf(r.id), 600);
  w.clock.add(11 * MIN); await w.opr.tick();   // all timed out unsubmitted: still in the pot
  assert.equal(w.opr.potOf(r.id), 600);
  assert.equal(w.opr.publicRound(w.opr.roundRow(r.id)).potSats, 600);
});

test('#3248 submit within 10 minutes; later the attempt is closed with 0', async () => {
  const w = world({ start: '2026-11-23T01:00:00Z' });
  const r = await openRound(w);
  const p = keypair();
  const a = await paidAttempt(w, p.pk, r.id);
  assert.equal(a.deadlineMs - a.startedMs, 10 * MIN);
  w.clock.add(10 * MIN + 1);
  const s = w.opr.submit(p.pk, { attempt: a.attempt, token: a.token, log: logOf(5) });
  assert.equal(s.ok, false); assert.match(s.why, /10 minutes/);
  assert.equal(w.opr.boardOf(r.id).length, 0);
});

test('#3248 no new attempt in the last 5 minutes; an invoice never outlives the round', async () => {
  const w = world({ start: '2026-11-23T00:00:10Z' });
  const r = await openRound(w);
  w.clock.set(at('2026-11-23T23:50:00Z'));
  const p = keypair();
  const s = await w.opr.startAttempt(p.pk, { round: r.id });
  assert.equal(s.ok, true);
  assert.ok(s.expiresMs <= r.end_ms && s.expiresMs === Math.min(s.deadlineMs, s.startedMs + 30000));   // #3265, #3603: the invoice lives 30 s (paid first), never past the run or the round
  w.clock.set(at('2026-11-23T23:55:00Z'));
  const late = await w.opr.startAttempt(p.pk, { round: r.id });
  assert.equal(late.ok, false); assert.match(late.why, /last 5 minutes/);
  // a run started just before the cutoff must be in before the round ends
  w.lnd.pay(s.invoice); const c = await w.opr.checkAttempt(p.pk, s.attempt);
  assert.ok(c.deadlineMs <= r.end_ms);
});

test('#3248 the round closes on time: the board freezes, unsubmitted runs time out', async () => {
  const w = world({ start: '2026-11-23T10:00:00Z' });
  const r = await openRound(w);
  const p = keypair(), q = keypair();
  const a = await paidAttempt(w, p.pk, r.id); w.clock.add(30000);
  assert.equal(w.opr.submit(p.pk, { attempt: a.attempt, token: a.token, log: logOf(4) }).ok, true);
  w.clock.set(at('2026-11-23T23:54:00Z'));
  const b = await paidAttempt(w, q.pk, r.id);
  w.clock.set(at('2026-11-24T00:00:00Z')); await w.opr.tick();
  assert.equal(w.opr.roundRow(r.id).state, 'closed');
  assert.equal(w.opr.submit(q.pk, { attempt: b.attempt, token: b.token, log: logOf(9) }).ok, false);
  assert.deepEqual(w.opr.boardOf(r.id).map((x) => x.total), [40]);
  // the next day's round is made at the same tick
  assert.ok(w.opr.roundRow('2026-11-24'));
});
