// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// GET /games' live counts: the rounds of each game live now at this seat, and the players in them.
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH } from '../../nextblock/plugin/nextblock.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { test } from 'node:test';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../arena-protocol/src/donation.js';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { HOSTED } from './plugins/hosted.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
const b32 = (n) => new Uint8Array(32).fill(n);
const contract = () => ({
  networkId: b32(0x4e), configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH, startTimeMs: 60500n, entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients),
  censusHeight: 900000, censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash',
  stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: BLOCK_TICKS,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: [b32(4)],
});
const entryFor = (rid) => ({
  roundId: rid, playerPubkey: b32(5), sessionPubkey: b32(6),
  stakeCommitment: b32(7), stakeMsat: 100000n, feeMsat: entryFeeMsat(100000n), donationMsat: 0n, joinTick: 0, worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
});
import { gameLive } from '../src/game-live.js';

// HOW MANY PLAY EACH GAME NOW: a round is live from its seating close (start - 120 s, §5A.7) to its end -
// never from its committee time, from which a series drawn 72 h ahead counted 1,266 Tick Tock rounds on testnet4
test('a round is live from start - 120 s to its end, with the players entered in it; rounds hours ahead are not live', () => {
  let now = 1000000;
  const r = new Round(openStore(), () => now, { plugins: HOSTED });
  const at = (startMs) => ({ ...contract(), committeeTimeMs: 500n, startTimeMs: BigInt(startMs), entryCloseMs: BigInt(startMs + 45000) });
  const near = r.open(at(now + 100000));                 // starts in 100 s: seated, live
  r.open(at(now + 300000));                              // in 5 min: not yet
  r.open(at(now + 3600000 * 40));                        // a series round 40 h ahead: not live
  r.enter(entryFor(near));
  const live = gameLive(r, { nowMs: () => now });
  assert.deepEqual(live()[toHex(NEXTBLOCK_GAME_ID)], { rounds: 1, players: 1 });
  now += 200000;                                         // the first has started, the second is 100 s away: both live
  const later = gameLive(r, { nowMs: () => now });
  assert.deepEqual(later()[toHex(NEXTBLOCK_GAME_ID)], { rounds: 2, players: 1 });
});

test('a round taking entries for hours after its start is live until its entry close plus one run (2026-10-14: Tick Tock "shows no open round")', () => {
  let now = 100000000;
  const r = new Round(openStore(), () => now, { plugins: HOSTED });
  const sixHours = 6 * 3600000;
  // started 3 h ago, entries open 6 h from its start - as testnet4's Tick Tock rounds
  r.open({ ...contract(), committeeTimeMs: 500n, startTimeMs: BigInt(now - 3 * 3600000), entryCloseMs: BigInt(now - 3 * 3600000 + sixHours) });
  const live = gameLive(r, { nowMs: () => now });
  assert.equal(live()[toHex(NEXTBLOCK_GAME_ID)].rounds, 1, 'open for entries: live');
  now += 3 * 3600000 + Math.ceil(Number(BLOCK_TICKS) * 1000 / 60) + 31000;   // past the entry close, its run and the 30 s grace
  const later = gameLive(r, { nowMs: () => now });
  assert.equal((later()[toHex(NEXTBLOCK_GAME_ID)] || { rounds: 0 }).rounds, 0, 'closed and run: not live');
});
