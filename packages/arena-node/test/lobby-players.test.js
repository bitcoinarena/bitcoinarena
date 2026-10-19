// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH } from '../../nextblock/plugin/nextblock.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../arena-protocol/src/donation.js';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { encodeInputBatch } from '../../arena-protocol/src/batch.js';
import { GENESIS } from '../../arena-protocol/src/transcript.js';
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { HOSTED } from './plugins/hosted.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

// THE LOBBY COUNTS PLAYERS, NOT ENTRIES (2026-09-16 15:36: "after each successful run lobby says 1
// joined then 2 then 3 as if he never left"). Every PLAY is a new entry; measured on the Daily, one free round
// held 7 entries from a single player key, and its row said 7 joined.
const b32 = (n) => new Uint8Array(32).fill(n);
const contract = () => ({
  networkId: b32(0x4e), configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH, startTimeMs: 60500n, entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients),
  censusHeight: 900000, censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash',
  stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: BLOCK_TICKS,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: [b32(4)],
});
// One entry of `player`, told apart from that player's other entries by its session key.
const entryOf = (rid, player, run) => ({
  roundId: rid, playerPubkey: b32(player), sessionPubkey: b32(0x60 + run),
  stakeCommitment: b32(7), stakeMsat: 100000n, feeMsat: entryFeeMsat(100000n), donationMsat: 0n, joinTick: 0, worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
});
const tick = (round, rid, eid) => round.batch(encodeInputBatch({
  roundId: rid, entryId: eid, previousHash: GENESIS, firstTick: 0, ticks: [[65536, 0, 0, 0, 0]], liquidations: [],
}));

test('one player who played three runs is one player joined, and one playing', () => {
  const round = new Round(openStore(), () => 1234, { plugins: HOSTED });
  const rid = round.open(contract());
  const runs = [0, 1, 2].map((run) => round.enter(entryOf(rid, 0x05, run)));
  assert.equal(new Set(runs.map((e) => Buffer.from(e).toString('hex'))).size, 3, 'three entries, or this measures nothing');
  for (const eid of runs) tick(round, rid, eid);
  assert.deepEqual(round.playersOf(rid), { joined: 1, playing: 1 },
    'one player key with three entries was counted as more than one player');
});

test('two players are two, and only the one who sent ticks is playing', () => {
  const round = new Round(openStore(), () => 1234, { plugins: HOSTED });
  const rid = round.open(contract());
  const a1 = round.enter(entryOf(rid, 0x05, 0));
  round.enter(entryOf(rid, 0x05, 1));
  round.enter(entryOf(rid, 0x09, 0));
  tick(round, rid, a1);
  assert.deepEqual(round.playersOf(rid), { joined: 2, playing: 1 });
  assert.deepEqual(new Round(openStore(), () => 1234, { plugins: HOSTED }).playersOf(new Uint8Array(32)), { joined: 0, playing: 0 },
    'a round nobody entered');
});
