// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1216 (audit 3 #1210 CONSENSUS-1): a replayed game's round took an entry new to a seat until it closed, and only head-to-head entries were
// handed on between seats - a player could post an entry and its lock to some seats only, play there, and post it to the rest once the run had won
// (paid), or not at all (VOID: the stake back). Now every game's entry, handout and lock is handed on to the other seats, and an entry new to a seat
// after the entry close (and its grace) is refused for every game.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { b32 } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { ENTRY_CLOSE_GRACE_MS } from '../src/round.js';

const until = async (ok, ms = 6000) => { const stop = Date.now() + ms; while (Date.now() < stop) { if (ok()) return true; await new Promise((r) => setTimeout(r, 100)); } return ok(); };

test('#1216 an entry posted to one seat of a replayed game\'s round reaches the other, with its handout and lock', async () => {
  const w = await lockRound({});
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const P = { name: 'withholder', key: b32(0x61), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] };
    const a = await lockAndPlay(w, P, { unreached: [1], noMarks: true });
    const t0 = Date.now();
    const other = w.nodes[1].round;
    const entry = await until(() => !!other.entry(a.eid));
    const lock = await until(() => !!other.stakeLock(a.eid));
    console.log('  MEASURED #1216 relay:', JSON.stringify({ posted: 'seat 0 only', atSeat1: { entry, lock, ms: Date.now() - t0 } }));
    assert.equal(entry, true, 'the entry did not reach the seat it was withheld from');
    assert.equal(lock, true, 'its lock did not reach the seat it was withheld from');
  } finally { await w.close(); }
});

test('#1216 an entry new to a seat after the entry close and its grace is refused; inside the grace it is taken', async () => {
  // a round whose entry close is still ahead (the fixture's default ends 3 s after it is built, its entry long closed)
  const w = await lockRound({ serveOpts: { entryCloseGraceMs: ENTRY_CLOSE_GRACE_MS }, endMs: testNow() + 600000 });
  assert.ok(Number(w.c.entryCloseMs) > testNow(), 'the round\'s entry close is not ahead');
  try {
    skipTo(Number(w.c.entryCloseMs) + 5000);
    const inGrace = await lockAndPlay(w, { name: 'in-grace', key: b32(0x62), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] }, { noMarks: true }).then(() => 'taken', (e) => e.message);
    skipTo(Number(w.c.entryCloseMs) + Number(ENTRY_CLOSE_GRACE_MS) + 5000);
    const late = await lockAndPlay(w, { name: 'late', key: b32(0x63), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] }, { noMarks: true }).then(() => 'taken', (e) => e.message);
    console.log('  MEASURED #1216 door:', JSON.stringify({ graceMs: Number(ENTRY_CLOSE_GRACE_MS), inGrace, late: late.slice(0, 160) }));
    assert.equal(inGrace, 'taken');
    assert.match(late, /entry closed at .* an entry new to this seat is not taken/);
  } finally { await w.close(); }
});
