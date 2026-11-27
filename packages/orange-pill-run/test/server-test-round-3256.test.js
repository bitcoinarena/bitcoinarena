// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #3256: a test round may allow more attempts (maxAttempts 1..99, default 5); the daily rounds stay at 5.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { world, openRound, paidAttempt, keypair, at } from './server-helpers.mjs';
import { introModel } from '../client/src/screens.js';

test('#3256 a test round with maxAttempts 10 allows the 6th..10th attempt and refuses the 11th', async () => {
  const w = world({ start: '2026-11-22T10:00:00Z' });
  const made = w.opr.testRound({ startMs: at('2026-11-22T10:00:00Z'), minutes: 60, chartDay: '2026-11-21', by: 'owner', maxAttempts: 10 });
  assert.equal(made.ok, true, made.why);
  assert.equal(made.round.maxAttempts, 10);
  const r = await openRound(w, made.round.id);
  assert.equal(r.max_attempts, 10);
  const p = keypair();
  for (let i = 1; i <= 10; i++) { const a = await paidAttempt(w, p.pk, r.id); assert.equal(a.state, 'started', `attempt ${i}: ${a.why}`); }
  const eleventh = await w.opr.startAttempt(p.pk, { round: r.id });
  assert.equal(eleventh.ok, false); assert.equal(eleventh.why, 'all 10 attempts of this round are used');
  // the intro reads the round's own limit
  const round = { ...w.opr.publicRound(w.opr.roundRow(r.id)), phase: 'open' };
  const m = introModel({ round, me: { used: 10, attempts: [] }, board: [], wallet: { pubkey: p.pk, balance: { sats: 1000 } }, nowMs: w.clock.now() });
  assert.equal(m.attempts, 'Your attempts: 10 of 10');
  assert.equal(m.button.disabled, true); assert.equal(m.button.why, 'All 10 attempts of this round are used.');
});

test('#3256 maxAttempts: default 5, only whole numbers 1..99; the daily round stays at 5', async () => {
  const w = world({ start: '2026-11-22T10:00:00Z' });
  for (const bad of [0, 100, 2.5, '7x', -1]) {
    const x = w.opr.testRound({ startMs: at('2026-11-22T10:00:00Z'), minutes: 30, chartDay: '2026-11-21', maxAttempts: bad });
    assert.equal(x.ok, false); assert.equal(x.why, 'maxAttempts is a whole number from 1 to 99');
  }
  const d = w.opr.testRound({ startMs: at('2026-11-22T10:00:00Z'), minutes: 30, chartDay: '2026-11-21' });
  assert.equal(d.ok, true, d.why); assert.equal(d.round.maxAttempts, 5);
  const r = await openRound(w, d.round.id);
  const p = keypair();
  for (let i = 0; i < 5; i++) assert.equal((await paidAttempt(w, p.pk, r.id)).state, 'started');
  assert.equal((await w.opr.startAttempt(p.pk, { round: r.id })).why, 'all 5 attempts of this round are used');
  // the first daily round (2026-11-23) after the test round: 5
  w.clock.set(at('2026-11-23T00:30:00Z'));
  const daily = await openRound(w);
  assert.equal(daily.test, 0); assert.equal(daily.max_attempts, 5);
});

test('#3256 a test round with maxAttempts 99 is made and plays 99 attempts, 100 is refused at creation; the intro says "n of 99"', async () => {
  const w = world({ start: '2026-11-22T10:00:00Z' });
  const no = w.opr.testRound({ startMs: at('2026-11-22T10:00:00Z'), minutes: 60, chartDay: '2026-11-21', maxAttempts: 100 });
  assert.equal(no.ok, false); assert.equal(no.why, 'maxAttempts is a whole number from 1 to 99');
  // over the admin door too
  const srv = createServer((q, x) => w.opr.handle(q, x));
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const call = async (body) => { const r = await fetch(`http://127.0.0.1:${srv.address().port}/admin/test-round`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-arena-admin': 'letmein' }, body: JSON.stringify(body) }); return { code: r.status, body: await r.json() }; };
  let res;
  try {
    res = await call({ startMs: at('2026-11-22T10:00:00Z'), minutes: 60, chartDay: '2026-11-21', maxAttempts: 100 });
    assert.equal(res.code, 400); assert.equal(res.body.why, 'maxAttempts is a whole number from 1 to 99');
    res = await call({ startMs: at('2026-11-22T10:00:00Z'), minutes: 60, chartDay: '2026-11-21', maxAttempts: 99 });
    assert.equal(res.code, 200, res.body.why); assert.equal(res.body.round.maxAttempts, 99);
  } finally { srv.close(); }
  const r = await openRound(w, res.body.round.id);
  assert.equal(r.max_attempts, 99);
  const p = keypair();
  for (let i = 1; i <= 99; i++) { const a = await paidAttempt(w, p.pk, r.id); assert.equal(a.state, 'started', `attempt ${i}: ${a.why}`); }
  assert.equal((await w.opr.startAttempt(p.pk, { round: r.id })).why, 'all 99 attempts of this round are used');
  const round = { ...w.opr.publicRound(w.opr.roundRow(r.id)), phase: 'open' };
  const m = introModel({ round, me: { used: 3, attempts: [] }, board: [], wallet: { pubkey: p.pk, balance: { sats: 1000 } }, nowMs: w.clock.now() });
  assert.equal(m.attempts, 'Your attempts: 3 of 99');
  assert.deepEqual(m.facts.find((f) => f[0] === 'Your attempts').slice(0, 2), ['Your attempts', '3 of 99']);
});
