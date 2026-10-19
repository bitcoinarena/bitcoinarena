// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN ON THE PAGE (2026-10-04 14:30: "A later join does not extend the round. The late joiner has less time.
// Join closes when 45 s remain"): a late-join round is offered until start + 37 s less a join's time, a late entry names the
// round tick it joins at and is held to that tick's instant, and its run is the round's run less those ticks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isLateJoinRound, lateJoinTick, entryOpenUntilMs, lateJoinLastEntryMs, LATE_JOIN_JOIN_MS, LATE_JOIN_SESSION_MS } from '../src/late-join.js';
import { lobbyOnePerKind } from '../src/lobby.js';
import { runTicksForEntry, lastTickOfRun } from '../../arena-protocol/src/contracts.js';
import { msForTicks, ticksForMs } from '../../arena-protocol/src/tick.js';

const START = 1_791_000_000_000;
const sid = new Uint8Array(32).fill(7);
const late = (start = START) => ({ seriesId: sid, startTimeMs: BigInt(start), entryCloseMs: BigInt(start + 45000), blockTicks: 4920 });
const atStart = { seriesId: sid, startTimeMs: BigInt(START), entryCloseMs: BigInt(START) };

test('a late-join round is offered until start + 32 s; the seats cut at start + 37 s; a round closing at its start keeps its close', () => {
  assert.equal(isLateJoinRound(late()), true);
  assert.equal(isLateJoinRound(atStart), false);
  assert.equal(isLateJoinRound({ startTimeMs: 1n, entryCloseMs: 2n }), false, 'not a series round');
  assert.equal(lateJoinLastEntryMs(late()), START + 37000);
  assert.equal(entryOpenUntilMs(late()), START + 37000 - LATE_JOIN_JOIN_MS);
  assert.equal(entryOpenUntilMs(atStart), START);
});

test('a late entry joins at the first tick due a session time from now, held to that instant; before the start, tick 0', () => {
  assert.deepEqual(lateJoinTick(late(), START - 10000), { joinTick: 0, atMs: null });
  assert.deepEqual(lateJoinTick(atStart, START + 20000), { joinTick: 0, atMs: null });
  const now = START + 25000;
  const { joinTick, atMs } = lateJoinTick(late(), now);
  assert.ok(atMs >= now + LATE_JOIN_SESSION_MS && atMs < now + LATE_JOIN_SESSION_MS + 17, `${atMs - now} ms ahead`);
  assert.equal(Number(ticksForMs(BigInt(atMs - START)).ticks), joinTick);
  assert.ok(Number(msForTicks(BigInt(joinTick)).ms) <= atMs - START);
  // AND ITS RUN ENDS WITH THE ROUND'S: 4920 - J ticks, the last one the round's 4919
  assert.equal(runTicksForEntry(joinTick, 4920), 4920 - joinTick);
  assert.equal(lastTickOfRun(joinTick, 4920), 4919);
  const leftS = Number(msForTicks(BigInt(4920 - joinTick)).ms) / 1000;
  assert.ok(leftS > 53 && leftS < 54.1, `a join at start + 25 s runs ${leftS} s (its tick is due at + 28 s)`);
});

const row = (id, inS, i) => {
  const c = { ...late(START + inS * 1000), roundIndex: BigInt(i) };
  return { id, free: false, joinable: true, phase: 'open', stakeMsat: 100000n, startTimeMs: START + inS * 1000,
    entryCloseMs: entryOpenUntilMs(c), contract: c };
};

test('the paid row moves to the next round at start + 32 s, so a PLAY at start + 38 s is never offered that round', () => {
  const rows = [row('x', 0, 0), row('y', 90, 1)];
  for (const [t, want] of [[25000, 'x'], [31900, 'x'], [32000, 'y'], [38000, 'y'], [44000, 'y']]) {
    const [r] = lobbyOnePerKind(rows, START + t, { paidSeriesOnly: true });
    assert.equal(r.id, want, `at start + ${t} ms`);
    assert.ok(r.entryCloseMs - (START + t) <= 90000);
  }
});
