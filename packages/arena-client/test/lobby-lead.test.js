// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SOONEST ROUND WHEN NOTHING MUST BE DEPOSITED FIRST (2026-10-03: "I always have to wait for the next round that
// starts in XX minutes"): a funded wallet's paid row is the soonest series round with 15 s of entry left; a wallet that must
// deposit first keeps the 90 s lead. The next round after a run skips one about to close.
import test from 'node:test';
import assert from 'node:assert/strict';
import { lobbyOnePerKind, SERIES_JOIN_LEAD_MS, FUNDED_JOIN_LEAD_MS, JOIN_LEAD_MS } from '../src/lobby.js';
import { nextRoundAfter } from '../src/next-round.js';

const NOW = 1_000_000_000;
const sid = new Uint8Array(32).fill(7);
const paid = (id, inS, i) => ({ id, free: false, joinable: true, phase: 'open', stakeMsat: 100000n, startTimeMs: NOW + inS * 1000,
  entryCloseMs: NOW + inS * 1000, contract: { seriesId: sid, startTimeMs: BigInt(NOW + inS * 1000), roundIndex: BigInt(i) } });
const rows = [paid('a', 20, 0), paid('b', 110, 1), paid('c', 200, 2)];

test('a funded wallet gets the round 20 s away; a wallet that must deposit gets the first with 90 s left', () => {
  const funded = lobbyOnePerKind(rows, NOW, { paidSeriesOnly: true, leadMsFor: () => FUNDED_JOIN_LEAD_MS });
  assert.deepEqual(funded.map((r) => r.id), ['a']);
  const empty = lobbyOnePerKind(rows, NOW, { paidSeriesOnly: true, leadMsFor: () => SERIES_JOIN_LEAD_MS });
  assert.deepEqual(empty.map((r) => r.id), ['b']);
  assert.deepEqual(lobbyOnePerKind(rows, NOW, { paidSeriesOnly: true }).map((r) => r.id), ['a'], 'the default is no lead');
});

test('the next round after a run skips one with under 15 s of entry left', () => {
  const played = { stakeMsat: 100000n, startTimeMs: NOW - 70000 };
  assert.equal(nextRoundAfter(played, [paid('soon', 10, 0), paid('next', 100, 1)], NOW).id, 'next');
  assert.equal(nextRoundAfter(played, [paid('ok', 20, 0), paid('next', 110, 1)], NOW).id, 'ok');
});

// KANBAN: "closes in" is never over 90 s - the soonest round whose entry is open, at every instant of a series
test('with no lead the paid row closes within 90 s at every instant of a 90 s series', () => {
  const series = Array.from({ length: 6 }, (_, i) => paid('r' + i, 45 + i * 90, i));
  let worst = 0;
  for (let t = 0; t < 400000; t += 250) {
    const [r] = lobbyOnePerKind(series, NOW + t, { paidSeriesOnly: true, leadMsFor: () => JOIN_LEAD_MS });
    const left = r.entryCloseMs - (NOW + t);
    assert.ok(left > 0, `at +${t} ms the row's entry is open`);
    worst = Math.max(worst, left);
  }
  assert.ok(worst <= 90000, `worst closes-in ${worst} ms`);
});
