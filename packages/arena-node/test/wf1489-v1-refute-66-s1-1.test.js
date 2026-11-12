// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute of #1488 (Hexbox #011, attack 2): a load DECLARED IN ADVANCE at a future tick, in a batch of no
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
const DRIVE = [65536, 3000, 0, 0, 0];
const FULL = [16334, 141, 369618];            // a full bed, paid like a real one (the fix's own honest values)

test('#1488 attack 2 by a load declared ahead: an empty batch at a future firstTick carries the bed past the drive', () => {
  const r = new Round(openStore(), () => 1234, { plugins: HOSTED });
  const rid = r.open(contract());
  const eid = r.enter(entryFor(rid));
  let previousHash = GENESIS;
  const send = (firstTick, ticks, loads = []) => {
    const b = { roundId: rid, entryId: eid, previousHash, firstTick, ticks, liquidations: [], loads };
    const took = r.batch(encodeInputBatch(b));
    previousHash = batchId(b);
    return took;
  };
  const GATE = 398;
  // the control: the same load sent after driving is refused (the fix's own case)
  // (1) before the truck moves: a batch of NO ticks whose firstTick is the tick before the gate, the full bed on it
  let ahead = null;
  try { send(GATE, [], [[GATE, ...FULL]]); ahead = 'taken'; } catch (e) { ahead = e.message; }
  // (2) then drive from tick 0, the whole way, with no load at all
  let drove = null;
  try { drove = send(0, Array.from({ length: GATE }, () => DRIVE)); } catch (e) { drove = e.message; }
  const t = r.transcript(rid, eid);
  let handed = null; try { handed = r.handOver(rid, eid).ticks; } catch (e) { handed = e.message; }
  console.log(`  handOver of the stored chain: ${handed}`);
  // what a replay of the stored run does: the war hunts an empty truck (heat 0, C 0) until GATE, then C is a full bed
  const st = CORE.start(0x1234, null);
  const ev = CORE.eventsOf(t);
  let cBefore = null;
  for (const { tick, words } of t.ticks) { ev.before(st, tick); if (tick === GATE - 1) cBefore = cargoOf(st); CORE.step(st, words); }
  ev.before(st, GATE);
  console.log(`  ahead: ${ahead}; drove: ${drove}; stored loads ${JSON.stringify(t.loads)}; C during the drive ${cBefore}, C at the gate ${cargoOf(st)}`);
  assert.notEqual(ahead, 'taken', 'a load at a tick no batch has reached yet is taken before the truck was driven - and applies after the drive');
});
