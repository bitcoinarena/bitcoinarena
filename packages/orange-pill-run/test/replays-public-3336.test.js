// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #3336 (owner 2026-11-22: "Und wir wollen alle Replays sehen"): every leaderboard row's best run is public, for everyone, at any time -
// also while the round runs, also below the top 10. A weaker run of a player, or a disqualified player's run, stays its own player's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { world, openRound, paidAttempt, keypair, logOf } from './server-helpers.mjs';

test('#3336 every board row has a replay any stranger can open while the round runs; a weaker run stays its player\'s', async () => {
  const w = world({ start: '2026-11-23T01:00:00Z' }); const r = await openRound(w);
  const ps = Array.from({ length: 12 }, () => keypair());
  const ids = new Map();
  for (const [i, p] of ps.entries()) {
    const x = await paidAttempt(w, p.pk, r.id); w.clock.add(60000);
    assert.equal(w.opr.submit(p.pk, { attempt: x.attempt, token: x.token, log: logOf(3 + i) }).ok, true); ids.set(p.pk, x.attempt);
  }
  // the first player's second, weaker run
  const weak = await paidAttempt(w, ps[0].pk, r.id); w.clock.add(60000);
  assert.equal(w.opr.submit(ps[0].pk, { attempt: weak.attempt, token: weak.token, log: logOf(1) }).ok, true);
  assert.ok(w.clock.now() < r.endMs || w.clock.now() < (w.opr.db.prepare('SELECT end_ms FROM rounds WHERE id = ?').get(r.id).end_ms));   // still running
  const srv = createServer((q, s) => w.opr.handle(q, s)); await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const get = async (path) => { const res = await fetch(`http://127.0.0.1:${srv.address().port}${path}`); return { status: res.status, json: await res.json() }; };
  try {
    const board = (await get(`/board?round=${r.id}`)).json.board;
    assert.equal(board.length, 12);
    assert.ok(board.every((x) => typeof x.replay === 'string'), 'a replay on every row, rank 11 and 12 too');
    for (const x of board) {
      const rp = await get(x.replay);
      assert.equal(rp.status, 200, `rank ${x.rank}`);
      assert.equal(rp.json.score.total, x.score);
      assert.equal(rp.json.level.candles.length, 48);
    }
    const no = await get(`/replay/${weak.attempt}`);
    assert.equal(no.status, 403); assert.match(no.json.why, /best run of each leaderboard row/);
  } finally { srv.close(); }
});
