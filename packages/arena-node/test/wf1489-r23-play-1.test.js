// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #2826, wf1489 r23 play-1: a run's tick numbers are the player's own and are never set against the round's clock.
// Safe behaviour: a seat does not take inputs / marks for a tick far behind the round's own time (here 38 s, more than
// the start deadline of 900 ticks = 15 s): otherwise a modified client plays its run that far behind the round and
// steers each tick with the committee's price samples for the next half minute already in hand (§11: sample k is
// attested at round time (k-1) x 5 s - the price of round time, not of the player's tick).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH, NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../arena-protocol/src/donation.js';
import { assumeAssigned } from './assignment.js';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { encodeCheckpoint, checkpointId, NO_PREVIOUS, joinSigned } from '../../arena-protocol/src/checkpoint.js';
import { encodeInputBatch, batchId } from '../../arena-protocol/src/batch.js';
import { GENESIS } from '../../arena-protocol/src/transcript.js';
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { ticksForMs } from '../../arena-protocol/src/tick.js';
import { HOSTED } from './plugins/hosted.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const START = 60500n;
const contract = () => ({
  networkId: b32(0x4e), configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH,
  startTimeMs: START, entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT',
  federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients),
  censusHeight: 900000, censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n, bondMinSats: 50000n,
  blockTicks: BLOCK_TICKS, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150, minScore: 1,
  rankNumerator: 3, rankDenominator: 4, nodes: [b32(4)],
});
const session = ed25519.utils.randomSecretKey();
const sign = (c) => joinSigned(encodeCheckpoint(c), ed25519.sign(checkpointId(c), session));

function play(lagMs) {
  let now = 1234;
  const r = new Round(openStore(), () => now, { plugins: HOSTED });
  const c = contract();
  const rid = r.open(c);
  assumeAssigned(r, rid, c.nodes);
  const eid = r.enter({ roundId: rid, playerPubkey: b32(5), sessionPubkey: ed25519.getPublicKey(session), stakeCommitment: b32(7),
    stakeMsat: 100000n, feeMsat: entryFeeMsat(100000n), donationMsat: 0n, joinTick: 0, worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32),
    stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n },
    feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32) });
  const words = (n, from) => Array.from({ length: n }, (_, i) => [65536, from + i, 0, 0, 0]);
  // ON TIME: one second into the round, ticks 0-59 and the first mark at 60
  now = Number(START) + 1000;
  const b1 = { roundId: rid, entryId: eid, previousHash: GENESIS, firstTick: 0, ticks: words(60, 0), liquidations: [] };
  r.batch(encodeInputBatch(b1));
  const m60 = { roundId: rid, entryId: eid, tick: 60, stateHash: b32(0x60), inputChainHash: batchId(b1), previousHash: NO_PREVIOUS };
  assert.ok(r.checkpoint(sign(m60)) instanceof Uint8Array);
  // THEN 40 s INTO THE ROUND (round tick ~2400) the client sends ticks 60-119 and the mark at 120: 38 s behind
  now = Number(START) + lagMs;
  const roundTick = Number(ticksForMs(BigInt(lagMs)).ticks);
  const b2 = { roundId: rid, entryId: eid, previousHash: batchId(b1), firstTick: 60, ticks: words(60, 60), liquidations: [] };
  const m120 = { roundId: rid, entryId: eid, tick: 120, stateHash: b32(0x12), inputChainHash: batchId(b2), previousHash: checkpointId(m60) };
  let took = null; let receipt = null;
  try { took = r.batch(encodeInputBatch(b2)); } catch { took = null; }
  try { receipt = r.checkpoint(sign(m120)); } catch { receipt = null; }
  console.log(`round tick ${roundTick}; batch 60-119 taken: ${took}; mark at 120 receipted: ${receipt instanceof Uint8Array}`);
  return { receipt, roundTick };
}

test('a seat does not take a run played 38 s behind the round clock (price hindsight)', () => {
  const { receipt, roundTick } = play(40000);
  assert.ok(!(receipt instanceof Uint8Array), `the mark at tick 120 was receipted ${roundTick - 120} ticks behind the round's clock`);
});

test('a mark a few seconds late on a slow link is still receipted (lag under 600 ticks)', () => {
  const { receipt } = play(2000 + 8000);
  assert.ok(receipt instanceof Uint8Array);
});
