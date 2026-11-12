// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute of #1488 (Hexbox #011, attack 1, variant): a full bed paying 1 sat a parcel and no BTC.: a load DECLARED IN ADVANCE at a future tick, in a batch of no
// ticks. load-checks.js bounds a load to "a tick this batch carries", and for a batch of no ticks that is b.firstTick -
// but Round.batch checks firstTick against nextTick only when the batch carries ticks. So before the truck moves the
// player sends an empty batch whose firstTick is just before the gate, with a full bed on it: nothing has been driven
// yet, so it is taken; then he drives the whole run empty (heat 0, C 0), and the replay applies the full bed one tick
// before the gate - exactly the effect the fix refuses when the same load is sent late.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH, NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { CORE } from '../../nextblock/src/adapter.js';
import { cargoOf } from '../../nextblock/src/sim.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../arena-protocol/src/donation.js';
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { encodeInputBatch, batchId } from '../../arena-protocol/src/batch.js';
import { GENESIS } from '../../arena-protocol/src/transcript.js';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { HOSTED } from './plugins/hosted.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const contract = () => ({
  networkId: b32(0x4e), configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 6, gameVerifySlots: 7,
  settlementSlots: 7, gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH, startTimeMs: 60500n, entryCloseMs: 2000n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
  slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000, censusRoot: b32(2),
  committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n,
  bondMinSats: 50000n, blockTicks: BLOCK_TICKS,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: [b32(4)],
});
const entryFor = (rid) => ({
  roundId: rid, playerPubkey: b32(5), sessionPubkey: b32(6), stakeCommitment: b32(7),
  stakeMsat: 100000n, feeMsat: entryFeeMsat(100000n), donationMsat: 0n, joinTick: 0,
  worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
});
const HELD = [0, 0, 0, 0, 0];
const DRIVE = [65536, 3000, 0, 0, 0];

test('#1488 attack 1 at 7 sats: a full bed with heat ~0 is still taken (C = 1 at heat 0 is what Hexbox reported)', () => {
  const r = new Round(openStore(), () => 1234, { plugins: HOSTED });
  const rid = r.open(contract());
  const eid = r.enter(entryFor(rid));
  const b = { roundId: rid, entryId: eid, previousHash: GENESIS, firstTick: 0,
    ticks: Array.from({ length: 10 }, (_, t) => (t >= 1 ? DRIVE : HELD)), liquidations: [], loads: [[0, 7, 0, 393214]] };
  let took = null; try { took = r.batch(encodeInputBatch(b)); } catch (e) { took = e.message; }
  const st = CORE.start(0x1234, null);
  const ev = CORE.eventsOf(r.transcript(rid, eid));
  ev.before(st, 0);
  const heat = CORE.result(st).heat, c = cargoOf(st);
  console.log(`  taken: ${took}; C ${c} of 65536, heat ${heat} of 65536`);
  assert.ok(!(took === 10 && c >= 65000 && heat < 100), 'a full bed (C ~ 1) at heat ~ 0 is taken - the Hexbox 1 effect at 7 sats instead of 0');
});
