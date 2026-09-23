// A SIGNER NODE'S DOORS AFTER THE CLOSE (ruled 2026-09-23): shut, as ever - except, for a run whose final mark it holds
// back its close for, the batches that mark commits to and then that same mark. Nothing else: not a batch past the
// mark's tick, not another mark, not a node that holds no such ask, and not after the hold is dropped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';

import { TEST_FEDERATION_ID } from '../../protocol/src/test-federation.js';
import { TRUCK_CORE_HASH, TRUCK_CONFIG_HASH } from '../src/cores.js';
import { BLOCK_TICKS } from '../../core/src/rules/gate.js';
import { TEST_DONATION_SET_REGTEST } from '../../protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../protocol/src/donation.js';
import { assumeAssigned } from './assignment.js';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { encodeCheckpoint, checkpointId, NO_PREVIOUS, joinSigned } from '../../protocol/src/checkpoint.js';
import { encodeInputBatch, batchId } from '../../protocol/src/batch.js';
import { GENESIS } from '../../protocol/src/transcript.js';
import { entryFeeMsat } from '../../protocol/src/fee.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const contract = () => ({
  networkId: b32(0x4e), configHash: TRUCK_CONFIG_HASH, censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, simCoreHash: TRUCK_CORE_HASH,
  startTimeMs: 60500n, entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT',
  federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients),
  censusHeight: 900000, censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n, bondMinSats: 50000n,
  blockTicks: BLOCK_TICKS, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150, minScore: 1,
  rankNumerator: 3, rankDenominator: 4, nodes: [b32(4)],
});
const session = ed25519.utils.randomSecretKey();
const sign = (c) => joinSigned(encodeCheckpoint(c), ed25519.sign(checkpointId(c), session));

/** A round with one entry: inputs 0-59 and a mark at 60 taken while open; inputs 60-119 and the mark at 120 not yet. */
function rig() {
  const r = new Round(openStore(), () => 1234);
  const c = contract();
  const rid = r.open(c);
  assumeAssigned(r, rid, c.nodes);
  const eid = r.enter({ roundId: rid, playerPubkey: b32(5), sessionPubkey: ed25519.getPublicKey(session), stakeCommitment: b32(7),
    stakeMsat: 100000n, feeMsat: entryFeeMsat(100000n), donationMsat: 0n, joinTick: 0, worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32),
    stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n },
    feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32) });
  const words = (n, from) => Array.from({ length: n }, (_, i) => [65536, from + i, 0, 0, 0]);
  const b1 = { roundId: rid, entryId: eid, previousHash: GENESIS, firstTick: 0, ticks: words(60, 0), liquidations: [] };
  r.batch(encodeInputBatch(b1));
  const m60 = { roundId: rid, entryId: eid, tick: 60, stateHash: b32(0x60), inputChainHash: batchId(b1), previousHash: NO_PREVIOUS };
  assert.ok(r.checkpoint(sign(m60)) instanceof Uint8Array);
  const b2 = { roundId: rid, entryId: eid, previousHash: batchId(b1), firstTick: 60, ticks: words(60, 60), liquidations: [] };
  const past = { ...b2, ticks: words(70, 60) };                      // ticks 60-129: past the final mark's tick
  const m120 = { roundId: rid, entryId: eid, tick: 120, stateHash: b32(0x12), inputChainHash: batchId(b2), previousHash: checkpointId(m60) };
  const other = { ...m120, stateHash: b32(0x13) };                   // another mark at the same tick, same parent
  return { r, rid, eid, b2, past, m120, other };
}

test('after the close a node that holds no final-mark ask refuses every batch and every mark, as ever', () => {
  const { r, rid, b2, m120 } = rig();
  r.close(rid);
  assert.throws(() => r.batch(encodeInputBatch(b2)), /the round is closed/);
  assert.throws(() => r.checkpoint(sign(m120)), /the round is closed/);
});

test('a node holding back its close for the final mark takes that mark\'s batches, then that mark - and nothing else', () => {
  const { r, rid, eid, b2, past, m120, other } = rig();
  r.close(rid);
  r.putHeldFinalAsk({ roundId: rid, entryId: eid, mark: sign(m120), tick: 120 });
  // NOT A BATCH PAST THE MARK'S TICK, and NOT ANOTHER MARK - not even one at the same tick on the same parent.
  assert.throws(() => r.batch(encodeInputBatch(past)), /the round is closed/);
  assert.throws(() => r.checkpoint(sign(other)), /the round is closed/);
  // THE MARK BEFORE ITS INPUTS is the ordinary refusal of a mark over inputs this node does not hold.
  assert.throws(() => r.checkpoint(sign(m120)));
  // FEED FIRST: the batches the mark commits to, then the same mark - its receipt.
  assert.equal(r.batch(encodeInputBatch(b2)), 60);
  assert.equal(r.heldInputTicks(rid, eid), 120);
  assert.ok(r.checkpoint(sign(m120)) instanceof Uint8Array, 'the held mark was not taken once its inputs were');
  assert.equal(r.checkpoints(rid, eid).count, 2);
  // DROPPED - the run signed, or the settlement combined - and the doors are shut again.
  r.dropHeldFinalAsk(eid);
  assert.equal(r.heldFinalAsk(eid), null);
  assert.throws(() => r.checkpoint(sign(other)), /the round is closed/);
});
