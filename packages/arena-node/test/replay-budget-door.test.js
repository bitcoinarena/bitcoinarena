// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE REPLAY BUDGET, MEASURED (§34, kanban #303): after a seat replayed a real run, GET /replay-budget answers its measured speed - the
// median of its own replays, game time over wall time - and the players an 82 s round holds in the 600 s window at it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockPort } from './lock-fixture.js';
import { lockRound, lockAndPlay, closeRound } from './lock-round-fixture.js';
import { WINNER, wait } from './window-fixture.js';

test('a seat that replayed a run answers its measured replay speed and the round size it supports', async () => {
  const w = await lockRound({ port: lockPort() });
  try {
    const none = await (await fetch(`http://127.0.0.1:${w.a.port}/replay-budget`)).json();
    assert.equal(none.speedX, null, 'a number before any replay'); assert.equal(none.maxPlayersPerRound, null);
    await lockAndPlay(w, WINNER);
    await closeRound(w);                                     // the close replays the run in the seat's pool
    let got = null;
    for (const stop = Date.now() + 90000; Date.now() < stop; await wait(500)) {
      got = await (await fetch(`http://127.0.0.1:${w.a.port}/replay-budget?runMs=82000`)).json();
      if (got.samples > 0) break;
    }
    console.log('  REPLAY BUDGET (this machine):', JSON.stringify(got));
    assert.ok(got.samples >= 1, 'no replay was measured');
    assert.ok(got.speedX > 0); assert.equal(got.maxPlayersPerRound, Math.floor(got.speedX * 600000 / 82000));
  } finally { await w.close(); }
});
