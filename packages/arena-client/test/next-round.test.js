// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE NEXT ROUND, JOINED BY DEFAULT (2026-09-28, option 1 of A; NEXT-ROUND-1407). On real series rounds - 90 s
// apart, every run starting together at its start_time, at most 82 s - the page finds round i+1 while round i is on
// the road, holds the 8 s result card, then says exactly "joining next round in N seconds" beside "exit game" until
// the next start; "exit game" goes back to the lobby.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextRoundAfter, nextRoundView, joiningNextRoundIn, EXIT_GAME, RESULT_CARD_MS } from '../src/next-round.js';
import { seriesTemplate, seriesRound, seriesIndexAt, ROUND_PERIOD_MS } from '../../arena-protocol/src/series.js';
import { roundEndMs } from '../../arena-protocol/src/first-mark.js';
import { roundId } from '../../arena-protocol/src/contracts.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const H = 3600000n;
const base = (stakeMsat) => ({
  networkId: NETWORK_ID_REGTEST, configHash: b32(1), censusConfirmations: 1, gameVerifySlots: 2, settlementSlots: 2,
  gameId: NEXTBLOCK_GAME_ID, simCoreHash: b32(9), committeeTimeMs: 0n, randomnessRule: 'bitcoin-block-hash', startTimeMs: 0n, entryCloseMs: 0n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT',
  federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'],
  donationSetId: donationSetId(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000, censusRoot: b32(2),
  stakeMsat, bondMinSats: 50000n, blockTicks: 4920, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: [b32(7), b32(8)],
});
const K = seriesIndexAt(NETWORK_ID_REGTEST, 1790700000000);
const free = seriesTemplate(base(0n), K);
const paid = seriesTemplate(base(10000000n), K);
const other = seriesTemplate(base(5000000n), K);
// lobby rows as fetchLobby makes them, entry closing at the start (no late join)
const row = (c) => ({ id: toHex(roundId(c)), free: c.stakeMsat === 0n, stakeMsat: c.stakeMsat, startTimeMs: c.startTimeMs,
  entryCloseMs: c.entryCloseMs, joinable: true });

test('the words are exactly the ruled ones', () => {
  assert.equal(joiningNextRoundIn(52), 'joining next round in 52 seconds');
  assert.equal(EXIT_GAME, 'exit game');
  assert.equal(RESULT_CARD_MS, 8000);
});

test('a run lasts at most 82 s and ends at least 8 s before the next start', () => {
  const r3 = seriesRound(free, 3); const r4 = seriesRound(free, 4);
  assert.equal(r4.startTimeMs - r3.startTimeMs, ROUND_PERIOD_MS);
  assert.equal(ROUND_PERIOD_MS, 90000n);
  assert.equal(r3.entryCloseMs, r3.startTimeMs, 'all runs start together: no late join');
  // THE RUN is blockTicks at 60 ticks/s: 4920 = 82 s, so a run started at start_time ends 8 s before the next start.
  // (roundEndMs is the round's CLOSE, later: it adds twice the start deadline a late run may use - not the run.)
  const runMs = BigInt(r3.blockTicks) * 1000n / 60n;
  assert.equal(runMs, 82000n, `a run lasts ${runMs} ms`);
  assert.ok(r4.startTimeMs - (r3.startTimeMs + runMs) >= 8000n, 'the card has its 8 s before the next start');
  assert.ok(roundEndMs(r3) > r3.startTimeMs + runMs, 'the close deadline is after the run');
});

test('while round i is on the road the next round is i+1 of the same kind - not i, not i+2, not another stake', () => {
  const rows = [3, 4, 5].flatMap((i) => [row(seriesRound(free, i)), row(seriesRound(paid, i)), row(seriesRound(other, i))]);
  const played = seriesRound(free, 3);
  const onTheRoad = Number(played.startTimeMs) + 30000;
  assert.equal(nextRoundAfter(played, rows, onTheRoad).id, toHex(roundId(seriesRound(free, 4))));
  const paidPlayed = seriesRound(paid, 3);
  assert.equal(nextRoundAfter(paidPlayed, rows, onTheRoad).id, toHex(roundId(seriesRound(paid, 4))), 'a paying run continues at its own stake');
  // once round 4's entry has closed (its start has come), the next is round 5
  assert.equal(nextRoundAfter(played, rows, Number(seriesRound(free, 4).startTimeMs) + 1).id, toHex(roundId(seriesRound(free, 5))));
  assert.equal(nextRoundAfter(played, rows.filter((r) => !r.free), onTheRoad), null, 'no free round listed: none');
});

test('after the run: "joining next round in N seconds" beside "exit game" at once, not after the card\'s 8 s (COUNTDOWN-NOW-2209)', () => {
  const r3 = seriesRound(free, 3); const next = Number(seriesRound(free, 4).startTimeMs);
  const arrived = Number(r3.startTimeMs) + 30000;                 // delivered at 30 s
  // two seconds after the delivery the countdown is already up, beside the result card Unity keeps
  assert.deepEqual(nextRoundView({ runOverMs: arrived, nextStartMs: next, nowMs: arrived + 2000 }),
    { show: 'countdown', seconds: 58, line: 'joining next round in 58 seconds', exit: 'exit game' });
  assert.equal(nextRoundView({ runOverMs: arrived, nextStartMs: next, nowMs: arrived }).line, 'joining next round in 60 seconds');
  assert.equal(nextRoundView({ runOverMs: arrived, nextStartMs: next, nowMs: next - 400 }).line, 'joining next round in 1 seconds');
  assert.deepEqual(nextRoundView({ runOverMs: arrived, nextStartMs: next, nowMs: next }), { show: 'start' });
  // a run that used all 82 s: 8 s of countdown, then the next run
  const full = Number(r3.startTimeMs) + 82000;
  assert.equal(nextRoundView({ runOverMs: full, nextStartMs: next, nowMs: full + 1000 }).seconds, 7);
  // exit game: the lobby, not the next round - at once as well
  assert.deepEqual(nextRoundView({ runOverMs: arrived, nextStartMs: next, nowMs: arrived + 1000, exited: true }), { show: 'lobby' });
});

test('a round already running is left to the lobby: the page does not pull a player off the goal into it (#827)', () => {
  const played = { startTimeMs: 1000, stakeMsat: 0, free: true };
  const row = (start) => ({ id: String(start), free: true, stakeMsat: 0, joinable: true, startTimeMs: start, entryCloseMs: start + 45000 });
  const rows = [row(91000), row(181000)];
  assert.equal(nextRoundAfter(played, rows, 90000).startTimeMs, 91000, 'not started: entered');
  assert.equal(nextRoundAfter(played, rows, 100000).startTimeMs, 181000, 'started, its late join still open: the one after it');
});
