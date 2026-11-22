// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #3266 a carried pot is decided once: the next round takes a carry only from an APPROVED list, and no approval pays more pot than was paid in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { world, openRound, paidAttempt, keypair, logOf, MIN } from './server-helpers.mjs';

const endRound = async (w, r) => { w.clock.set(r.end_ms); await w.opr.tick(); w.clock.add(60 * MIN); await w.opr.tick(); };
const potList = (w, id) => w.opr.listsOf(id).find((l) => l.kind === 'pot');
const approve = (w, id) => w.opr.decideList({ round: id, kind: 'pot', action: 'approve', by: 'admin' });
const entriesPaid = (w) => w.opr.db.prepare('SELECT COALESCE(SUM(r.entry_sats), 0) AS s FROM attempts a JOIN rounds r ON r.id = a.round WHERE a.paid_ms IS NOT NULL').get().s;
const payablePot = (w) => w.opr.payable().filter((l) => l.kind === 'pot').reduce((a, l) => a + l.sats, 0);
async function play(w, r, pk, presses) {
  const a = await paidAttempt(w, pk, r.id); w.clock.add(60000);
  const s = w.opr.submit(pk, { attempt: a.attempt, token: a.token, log: logOf(presses) });
  assert.equal(s.ok, true); return a.attempt;
}
/** Round N: one placed player whose only run is held; N's list carries 100. Round N+1: one placed player, list written. */
async function twoRounds() {
  const w = world({ start: '2026-11-23T01:00:00Z' });
  const n = await openRound(w), p = keypair(); w.link(p.pk);
  const held = await play(w, n, p.pk, 10);
  assert.equal(w.opr.review({ attempt: held, action: 'hold' }).ok, true);
  await endRound(w, n);
  assert.equal(potList(w, n.id).carrySats, 100);
  const m = await openRound(w, '2026-11-24'), q = keypair(); w.link(q.pk);
  await play(w, m, q.pk, 12);
  return { w, n, m, held };
}

test('#3266 the reporter\'s steps: held run in N, N+1 written, N\'s run cleared, both approved -> payable pot == paid entries', async () => {
  const { w, n, m, held } = await twoRounds();
  await endRound(w, m);
  assert.equal(potList(w, m.id).state, 'waiting');
  assert.equal(potList(w, m.id).sats, 100, 'N+1 takes no carry from a waiting list');
  assert.equal(w.opr.review({ attempt: held, action: 'clear' }).ok, true);
  assert.deepEqual([potList(w, n.id).sats, potList(w, n.id).carrySats], [100, 0]);
  assert.equal(approve(w, n.id).ok, true); assert.equal(approve(w, m.id).ok, true);
  assert.equal(payablePot(w), entriesPaid(w)); assert.equal(payablePot(w), 200);
});

test('#3266 a carry approved in N reaches N+1 while N+1 is still waiting (its list rebuilt); N is frozen after', async () => {
  const { w, n, m, held } = await twoRounds();
  await endRound(w, m);
  assert.equal(approve(w, n.id).ok, true);   // N approved with its carry of 100 (run still held)
  assert.deepEqual([potList(w, m.id).state, potList(w, m.id).sats], ['waiting', 200]);
  assert.equal(w.opr.potOf(m.id), 200);
  w.opr.review({ attempt: held, action: 'clear' });   // N is approved: clearing its run no longer rebuilds it
  assert.deepEqual([potList(w, n.id).sats, potList(w, n.id).carrySats], [0, 100]);
  assert.equal(approve(w, m.id).ok, true);
  assert.equal(payablePot(w), entriesPaid(w)); assert.equal(payablePot(w), 200);
});

test('#3266 a carry approved before N+1 has a list flows into N+1\'s list when it is written', async () => {
  const { w, n, m } = await twoRounds();
  assert.equal(approve(w, n.id).ok, true);   // N+1 still running
  assert.equal(w.opr.potOf(m.id), 200);
  await endRound(w, m);
  assert.equal(potList(w, m.id).sats, 200);
  assert.equal(approve(w, m.id).ok, true);
  assert.equal(payablePot(w), entriesPaid(w));
});

test('#3266 the guard: an approval that would pay more pot than was paid in is refused with the reason; payable() asserts it', async () => {
  const { w, n, m } = await twoRounds();
  await endRound(w, m);
  w.opr.db.prepare("UPDATE payout_lists SET sats = 300, rows = json_set(rows, '$[0].sats', 300) WHERE round = ? AND kind = 'pot'").run(m.id);   // a list that over-pays
  const r = approve(w, m.id);
  assert.equal(r.ok, false); assert.match(r.why, /pot sats .*more than the 100 sat of paid entries/);
  assert.equal(potList(w, m.id).state, 'waiting');
  w.opr.db.prepare("UPDATE payout_lists SET state = 'approved', by = 'x', at_ms = 1 WHERE round = ? AND kind = 'pot'").run(m.id);   // forced past the guard
  w.opr.db.prepare("INSERT INTO approvals (round, kind, action, by, at_ms) VALUES (?, 'pot', 'approved', 'x', 1)").run(m.id);
  assert.throws(() => w.opr.payable(), /pot sats .*more than the 100 sat of paid entries/);
});
