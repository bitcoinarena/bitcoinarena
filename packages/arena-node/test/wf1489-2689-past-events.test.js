// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r3 (play): AN EVENT AT A TICK THE RUN ALREADY PLAYED - THE PAST REWRITTEN AFTER ITS MARKS WERE RECEIPTED.
//
// round.batch holds a LOAD to the ticks its batch carries (load-checks.js loadsRefusal, kanban #1488/#1740/#1800), but a
// batch's liquidations, samples and tapes may name ANY tick - also one before the batch's first tick, which the run
// published (and the committee receipted a mark over) long before. The rows land in the seat's tables (INSERT OR IGNORE
// at that tick, nothing stored there yet) and the seat's close replays the tables - so the run the seat signs now has a
// price change (or a strike) at tick 60 that the mark at tick 120 the committee carried was computed without. The player
// plays on, simulates offline which past event helps, and sends it with a later batch before the close. And when that
// later batch is past the last carried mark, the canonical transcript (whose hash the seat signs, and which an
// objection replays) does not hold the event while the seat's replay does: the #1568 split again.
//
// Safe: an event of a batch is at a tick that batch carries (as a load is) - one naming a tick before its first tick is
// refused, and nothing is written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH, NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../arena-protocol/src/donation.js';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { assumeAssigned } from './assignment.js';
import { encodeInputBatch, batchId } from '../../arena-protocol/src/batch.js';
import { GENESIS, decodeTranscript } from '../../arena-protocol/src/transcript.js';
import { encodeCheckpoint, checkpointId, NO_PREVIOUS, joinSigned } from '../../arena-protocol/src/checkpoint.js';
import { encodeCheckpointReceipt, receiptId, joinSignedReceipt } from '../../arena-protocol/src/receipt.js';
import { priceSampleId, centsToTapeUnits } from '../../arena-protocol/src/price-sample.js';
import { receiptsNeeded } from '../../arena-protocol/src/genesis.js';
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { replayFormOf } from '../src/objection-check.js';
import { HOSTED } from './plugins/hosted.js';
import { CORE } from '../../nextblock/src/adapter.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const session = ed25519.utils.randomSecretKey();
const peers = [1, 2, 3, 4, 5, 6].map((n) => b32(0x40 + n));
const peerKeys = peers.map((sk) => schnorr.getPublicKey(sk));

function rig() {
  const r = new Round(openStore(), () => 1234, { plugins: HOSTED });
  const nodes = [...peerKeys, r.identity.pubkey];
  const c = {
    networkId: b32(0x4e), configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, gameId: NEXTBLOCK_GAME_ID,
    simCoreHash: TRUCK_CORE_HASH, startTimeMs: 60500n, entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
    slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'],
    donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000, censusRoot: b32(2), committeeTimeMs: 500n,
    randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: BLOCK_TICKS, exposureReference: 1000,
    corridorHalfWidth: 40, spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes,
  };
  const rid = r.open(c);
  assumeAssigned(r, rid, nodes);
  // THIS SEAT RUNS THE COMMITTEE'S FEED: a bare price is refused, only an attested one is taken (§11)
  r.pricesRequired = () => true;
  const eid = r.enter({ roundId: rid, playerPubkey: b32(5), sessionPubkey: ed25519.getPublicKey(session), stakeCommitment: b32(7),
    stakeMsat: 100000n, feeMsat: entryFeeMsat(100000n), donationMsat: 0n, joinTick: 0, worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32),
    stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n },
    feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32) });
  return { r, rid, eid, need: receiptsNeeded(7) };
}
const words = (n) => Array.from({ length: n }, () => [65536, 0, 0, 0, 0]);
const markOf = (c) => joinSigned(encodeCheckpoint(c), ed25519.sign(checkpointId(c), session));
const receiptFrom = (sk, id, ms) => {
  const x = { checkpointId: id, nodePubkey: schnorr.getPublicKey(sk), receivedAtMs: ms };
  return joinSignedReceipt(encodeCheckpointReceipt(x), schnorr.sign(receiptId(x), sk));
};

test('#1489-r3-play-1: a later batch carries an attested price at tick 60, a tick the run published and the committee receipted a mark over - refused', () => {
  const { r, rid, eid, need } = rig();
  // ticks 0..119 played with no price; the mark at 120 over them, carried by all seven
  const b1 = { roundId: rid, entryId: eid, previousHash: GENESIS, firstTick: 0, ticks: words(120), liquidations: [] };
  r.batch(encodeInputBatch(b1));
  const m120 = { roundId: rid, entryId: eid, tick: 120, stateHash: b32(0x12), inputChainHash: batchId(b1), previousHash: NO_PREVIOUS };
  assert.ok(r.checkpoint(markOf(m120)) instanceof Uint8Array);
  peers.forEach((sk, i) => r.takeReceipt(receiptFrom(sk, checkpointId(m120), 2000n + BigInt(i))));
  const before = r.canonicalTranscript(rid, eid);
  assert.equal(before.throughTick, 120);

  // THE ATTACK: the next batch (ticks 120..129) carries the committee's attested price for tick 60 - a real attestation
  // the player left out when it played tick 60, picked now that it knows which history it wants
  const cents = 8297193;
  const att = [60, 0, cents, peers.slice(0, need).map((sk, i) => [peerKeys[i], schnorr.sign(priceSampleId({ roundId: rid, tick: 60, priceCents: cents }), sk)])];
  const b2 = { roundId: rid, entryId: eid, previousHash: batchId(b1), firstTick: 120, ticks: words(10), liquidations: [],
    samples: [[60, centsToTapeUnits(cents)]], attests: [att] };
  let refused = null;
  try { r.batch(encodeInputBatch(b2)); } catch (e) { refused = e.message; }
  const seat = r.transcript(rid, eid);
  const canonical = replayFormOf(decodeTranscript(r.canonicalTranscript(rid, eid).bytes));
  // what the run is, replayed through tick 120 with and without that price (the state the carried mark is about)
  const stateAt120 = (t) => {
    const st = CORE.start(0x1234);
    const ev = CORE.eventsOf(t);
    for (let k = 0; k < 120; k++) { ev.before(st, k); CORE.step(st, t.ticks[k].words); }
    return CORE.stateHash(st);
  };
  const seatHash = stateAt120(seat), canonicalHash = stateAt120(canonical);
  console.log('  FACTS:', JSON.stringify({ refused, seatSamples: seat.samples, canonicalSamples: canonical.samples,
    stateAt120: { seatReplay: seatHash.slice(0, 16), canonical: canonicalHash.slice(0, 16) } }));
  assert.ok(refused, 'a batch starting at tick 120 was taken with a price at tick 60 - the past of a receipted run rewritten');
  assert.deepEqual(seat.samples, [], 'nothing of the refused batch was stored');
});

test('#1489-r3-play-1b: a later batch carries a liquidation at a tick already played - refused, as a load is', () => {
  const { r, rid, eid } = rig();
  const b1 = { roundId: rid, entryId: eid, previousHash: GENESIS, firstTick: 0, ticks: words(120), liquidations: [] };
  r.batch(encodeInputBatch(b1));
  const b2 = { roundId: rid, entryId: eid, previousHash: batchId(b1), firstTick: 120, ticks: words(10), liquidations: [[50, 40 << 16]] };
  let refused = null;
  try { r.batch(encodeInputBatch(b2)); } catch (e) { refused = e.message; }
  const seat = r.transcript(rid, eid);
  console.log('  FACTS:', JSON.stringify({ refused, seatLiquidations: seat.liquidations }));
  assert.ok(refused, 'a batch starting at tick 120 was taken with a strike at tick 50');
});
