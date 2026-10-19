// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN AT THE SEAT'S DOOR (2026-10-04 14:30: "Join closes when 45 s remain. A player who would have 45 s or
// less left must not enter and waits for the next round"). A late-join series round (entry_close = start + 45 s in its
// bytes) takes a new entry only before start + 37 s - at that instant 45 s of its run remain, so it is refused - and a late
// entry joins at the round's ticks already gone (less 10 s), so its run ends with the round's at start + 82 s.
// Fixtures from run-length.test.js.
//
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH } from '../../nextblock/plugin/nextblock.js';
import { test } from 'node:test';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../arena-protocol/src/donation.js';
import assert from 'node:assert/strict';

import { openStore } from '../src/store.js';
import { TRUCK_BEFORE_FORK_HASH } from '../../nextblock/plugin/nextblock.js';
import { GENESIS_CONFIG_HASH } from '../../arena-protocol/src/genesis-ids.js';
import { fromHex as fromHexForFork } from '../../arena-protocol/src/hash.js';
import { Round } from '../src/round.js';
import { replay as replayUnder } from '../src/replay.js';
import { TRUCK } from '../../nextblock/plugin/nextblock.js';
// THE TRUCK'S RUNS, REPLAYED UNDER THE TRUCK (M3 R1): replay takes the core it runs under; these are truck runs.
const replay = (t, e, o = {}) => replayUnder(t, e, { core: TRUCK, ...o });
import { encodeInputBatch } from '../../arena-protocol/src/batch.js';
import { MIN_ENTRY_WINDOW_MS } from '../../arena-protocol/src/constants.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { lastTickOfRun, runTicksForEntry, runLengthIsTheCores } from '../../arena-protocol/src/contracts.js';

// The node fee is 27A.7's 2% of the stake, and the door checks it now
// (M3.3 item 20) - so a fixture carries the RULE rather than a number.
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
const b32 = (n) => new Uint8Array(32).fill(n);
const NOW = 1788700000000;
const contractWith = (blockTicks) => ({
  networkId: NETWORK_ID_REGTEST, configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 6,
  gameVerifySlots: 2, settlementSlots: 2, gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH,
  committeeTimeMs: BigInt(NOW), randomnessRule: 'bitcoin-block-hash',
  startTimeMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS,
  entryCloseMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS + 200000n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
  slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000,
  censusRoot: b32(2), stakeMsat: 100000n, bondMinSats: 50000n, blockTicks,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: [b32(8), b32(9)],
});
const entryOn = (rid, joinTick = 0) => ({
  roundId: rid, playerPubkey: b32(5), sessionPubkey: b32(6), stakeCommitment: b32(7),
  stakeMsat: 100000n, feeMsat: entryFeeMsat(100000n), donationMsat: 0n, joinTick,
  worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
});
import { LATE_JOIN_MS, LATE_JOIN_LAST_ENTRY_MS } from '../../arena-protocol/src/series.js';
import { ticksForMs } from '../../arena-protocol/src/tick.js';
import { HOSTED } from './plugins/hosted.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const START = BigInt(NOW) + MIN_ENTRY_WINDOW_MS;
const lateJoinRound = () => ({ ...contractWith(BLOCK_TICKS), seriesId: b32(0x5a), roundIndex: 3, entryCloseMs: START + LATE_JOIN_MS });
let clock = NOW;
const door = () => { const r = new Round(openStore(':memory:'), () => clock, { plugins: HOSTED }); clock = NOW + 1000; return { r, rid: r.open(lateJoinRound()) }; };
const at = (msAfterStart) => { clock = Number(START) + msAfterStart; };
const ticksAt = (ms) => Number(ticksForMs(BigInt(ms)).ticks);
let n = 0;
const entry = (rid, joinTick) => ({ ...entryOn(rid, joinTick), playerPubkey: b32(0x40 + (n++ % 100)) });

test('a late-join round takes an entry at start + 36.999 s and refuses one at start + 37 s and after: 45 s or less left', () => {
  assert.equal(LATE_JOIN_LAST_ENTRY_MS, 37000n);
  const { r, rid } = door();
  at(36999); assert.ok(r.enter(entry(rid, ticksAt(36999))));
  at(37000); assert.throws(() => r.enter(entry(rid, ticksAt(37000))), /entry closed at .*start \+ 37000 ms: 45 s or less of its run left/);
  at(44000); assert.throws(() => r.enter(entry(rid, ticksAt(44000))), /45 s or less of its run left/);
  at(55000); assert.throws(() => r.enter(entry(rid, ticksAt(55000))), /45 s or less of its run left/, 'the old grace (to start + 60 s) is gone');
});

test('the same entry posted again after the cutoff is still taken (a retry, a reload, a peer)', () => {
  const { r, rid } = door();
  at(30000); const e = entry(rid, ticksAt(30000)); const id = r.enter(e);
  at(50000); assert.deepEqual(r.enter(e), id);
});

test('a late entry joins where the round is: a join tick more than 10 s behind the round clock is refused, and its run ends with the round', () => {
  const { r, rid } = door();
  at(25000);
  assert.throws(() => r.enter(entry(rid, 0)), /a late entry joins at tick \d+ or later, and its run ends with the round's/);
  assert.throws(() => r.enter(entry(rid, ticksAt(14000))), /a late entry joins at tick/);
  const j = ticksAt(25000);
  assert.ok(r.enter(entry(rid, j)));
  assert.equal(lastTickOfRun(j, BLOCK_TICKS), BLOCK_TICKS - 1);
  assert.equal(runTicksForEntry(j, BLOCK_TICKS), BLOCK_TICKS - j);
});

test('before the start an entry at tick 0 is taken as always, and a round closing entry at its start keeps its old door', () => {
  const { r, rid } = door();
  at(-5000); assert.ok(r.enter(entry(rid, 0)));
  const plain = new Round(openStore(':memory:'), () => clock, { plugins: HOSTED }); clock = NOW + 1000;
  const pid = plain.open(contractWith(BLOCK_TICKS));
  at(40000); assert.ok(plain.enter(entry(pid, 0)), 'not a late-join series round: no cutoff, no join-tick rule');
});
