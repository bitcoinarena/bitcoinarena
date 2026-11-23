// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #3249: the score is the server's replay of the log; refusals; bot signals; replays.
import test from 'node:test';
import assert from 'node:assert/strict';
import { world, openRound, paidAttempt, keypair, logOf, at } from './server-helpers.mjs';
import { logRefusal, runSignals } from '../server/opr-service.mjs';

async function started(start = '2026-11-23T01:00:00Z') {
  const w = world({ start }); const r = await openRound(w); const p = keypair();
  const a = await paidAttempt(w, p.pk, r.id); w.clock.add(60000);
  return { w, r, p, a };
}

test('#3249 a hand-edited score never reaches the board: the board holds the replayed score', async () => {
  const { w, r, p, a } = await started();
  const s = w.opr.submit(p.pk, { attempt: a.attempt, token: a.token, log: logOf(6), score: { total: 999999 }, total: 999999 });
  assert.equal(s.ok, true); assert.equal(s.score.total, 60);
  assert.deepEqual(w.opr.boardOf(r.id).map((x) => x.total), [60]);
});

test('#3249 a hand-edited log is refused: extra fields, overlap, unsorted, fractions, past the run, a score inside', async () => {
  const bad = [
    { v: 'opr-test-1', presses: [[5, 10]], score: 500 },
    { v: 'opr-test-1', presses: [[5, 10], [9, 20]] },
    { v: 'opr-test-1', presses: [[30, 40], [5, 10]] },
    { v: 'opr-test-1', presses: [[5.5, 10]] },
    { v: 'opr-test-1', presses: [[5, 5]] },
    { v: 'opr-test-1', presses: [[5, 10_000_000]] },
    { v: 'opr-test-1', presses: [[5, 10, 11]] },
    { v: 'opr-test-1', presses: 'x' },
    null,
  ];
  for (const log of bad) assert.ok(logRefusal(log, { maxSteps: 10920 }), JSON.stringify(log));
  assert.equal(logRefusal(logOf(20), { maxSteps: 10920 }), null);
  const { w, r, p, a } = await started();
  const s = w.opr.submit(p.pk, { attempt: a.attempt, token: a.token, log: bad[1] });
  assert.equal(s.ok, false); assert.match(s.why, /malformed log/);
  assert.equal(w.opr.boardOf(r.id).length, 0);
});

test('#3249 token reuse, a token of another round, someone else\'s token, an unknown token: refused', async () => {
  const { w, p, a } = await started();
  assert.equal(w.opr.submit(p.pk, { attempt: a.attempt, token: 'f'.repeat(64), log: logOf(3) }).why, 'unknown token');
  assert.equal(w.opr.submit(keypair().pk, { attempt: a.attempt, token: a.token, log: logOf(3) }).why, 'that token is not yours');
  assert.equal(w.opr.submit(p.pk, { attempt: a.attempt, token: a.token, round: '2026-11-24', log: logOf(3) }).why, 'that token is of another round');
  assert.equal(w.opr.submit(p.pk, { attempt: a.attempt, token: a.token, log: logOf(3) }).ok, true);
  assert.equal(w.opr.submit(p.pk, { attempt: a.attempt, token: a.token, log: logOf(9) }).why, 'that token was used already');
});

test('#3249 a run submitted faster than its game time is refused and the token is spent', async () => {
  const w = world({ start: '2026-11-23T01:00:00Z' }); const r = await openRound(w); const p = keypair();
  const a = await paidAttempt(w, p.pk, r.id);
  w.clock.add(3000);   // the log's run lasts 478 steps = 8 s
  const s = w.opr.submit(p.pk, { attempt: a.attempt, token: a.token, log: logOf(12) });
  assert.equal(s.ok, false); assert.match(s.why, /faster than the run's game time/);
  w.clock.add(60000);
  assert.equal(w.opr.submit(p.pk, { attempt: a.attempt, token: a.token, log: logOf(12) }).why, 'that token was used already');
  assert.equal(w.opr.boardOf(r.id).length, 0);
});

test('#3249 a log of another game version is refused', async () => {
  const { w, p, a } = await started();
  const s = w.opr.submit(p.pk, { attempt: a.attempt, token: a.token, log: logOf(5, 'opr-test-0') });
  assert.equal(s.ok, false); assert.match(s.why, /wrong game version/);
});

test('#3249 the board: best per player; tie on score -> shorter time, then the earlier submission', async () => {
  const w = world({ start: '2026-11-23T01:00:00Z' }); const r = await openRound(w);
  const [a, b, c] = [keypair(), keypair(), keypair()];
  const run = async (p, log) => { const x = await paidAttempt(w, p.pk, r.id); w.clock.add(60000); assert.equal(w.opr.submit(p.pk, { attempt: x.attempt, token: x.token, log }).ok, true); };
  await run(a, logOf(5)); await run(a, logOf(8)); await run(a, logOf(2));
  await run(b, logOf(8, undefined, 50));   // same score, longer run
  await run(c, logOf(8));                   // same score and time, later
  const board = w.opr.boardOf(r.id);
  assert.deepEqual(board.map((x) => [x.player, x.total, x.rank]), [[a.pk, 80, 1], [c.pk, 80, 2], [b.pk, 80, 3]]);
  const pub = w.opr.publicBoard(r.id);
  assert.equal(pub[0].attempts, 3); assert.equal(pub[0].replay, null);   // replays of a running round are not public
});

test('#3249 bot signals: too regular, identical logs across accounts, many accounts on one address, a hidden tab - stored, under review', async () => {
  const w = world({ start: '2026-11-23T01:00:00Z' }); const r = await openRound(w);
  const reg = { v: 'opr-test-1', presses: Array.from({ length: 20 }, (_, i) => [i * 40 + 3, i * 40 + 9]) };
  assert.deepEqual(runSignals(reg), { regular: true, sameHold: true });
  assert.deepEqual(runSignals(logOf(20), { visible: false }), { hidden: true });
  const ps = [keypair(), keypair(), keypair()];
  for (const p of ps) { const s = await w.opr.startAttempt(p.pk, { round: r.id, ip: '203.0.113.9' }); w.lnd.pay(s.invoice); const c = await w.opr.checkAttempt(p.pk, s.attempt);
    w.clock.add(60000); assert.equal(w.opr.submit(p.pk, { attempt: s.attempt, token: c.token, log: logOf(10) }, { ip: '203.0.113.9' }).ok, true); }
  const rows = w.opr.db.prepare('SELECT player, flags, review FROM attempts WHERE round = ? ORDER BY submitted_ms').all(r.id).map((x) => ({ ...x, flags: JSON.parse(x.flags) }));
  assert.ok(rows.every((x) => x.flags.sameLog && x.review === 'pending'));
  assert.equal(rows[2].flags.ipCrowd, 3);
  assert.equal(w.opr.boardOf(r.id).length, 3);   // flagged runs stay on the board
});

test('#3249 replays: own runs always; after the round the top 10; the replay is the stored log and the level', async () => {
  const w = world({ start: '2026-11-23T01:00:00Z' }); const r = await openRound(w);
  const p = keypair();
  const a = await paidAttempt(w, p.pk, r.id); w.clock.add(60000);
  const log = logOf(7);
  w.opr.submit(p.pk, { attempt: a.attempt, token: a.token, log });
  const stored = JSON.parse(w.opr.db.prepare('SELECT log FROM attempts WHERE id = ?').get(a.attempt).log);
  assert.deepEqual(stored, log);
  w.clock.set(at('2026-11-24T00:00:00Z'));
  assert.equal(w.opr.publicBoard(r.id)[0].replay, `/replay/${a.attempt}`);
});
