// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE CANONICAL TRANSCRIPT, SECTION 13C.
//
// "For each player, the canonical transcript is the longest checkpoint chain
// that carries receipts from at least 5 committee nodes, together with the
// input batches whose hashes it commits to. All nodes replay that object, so
// 'node A saw more than node B' cannot by itself produce disagreement."
//
// SELECTION, NOT SIMULATION. Nothing here replays anything and the node still
// imports no core - a daemon that recomputed the state would be a second
// simulator, and then two of them could disagree. What is measured is which
// marks the committee actually carried, and which inputs those marks commit to.
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH } from '../../nextblock/plugin/nextblock.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { test } from 'node:test';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../arena-protocol/src/donation.js';
import assert from 'node:assert/strict';
import { assumeAssigned } from './assignment.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';

import { openStore } from '../src/store.js';
import { Round, RECEIPTS_FOR_CANONICAL } from '../src/round.js';
import { serve } from '../src/server.js';
import { roundId, entryId } from '../../arena-protocol/src/contracts.js';
import { encodeInputBatch, batchId } from '../../arena-protocol/src/batch.js';
import {
  GENESIS, decodeTranscript, checkTranscript, transcriptHash,
} from '../../arena-protocol/src/transcript.js';
import {
  encodeCheckpoint, decodeCheckpoint, checkpointId, NO_PREVIOUS, joinSigned, splitSigned,
} from '../../arena-protocol/src/checkpoint.js';
import {
  encodeCheckpointReceipt, receiptId, joinSignedReceipt,
} from '../../arena-protocol/src/receipt.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { replayFormOf } from '../src/objection-check.js';
import { CORE } from '../../nextblock/src/adapter.js';

// The node fee is 27A.7's 2% of the stake, and the door checks it now
// (M3.3 item 20) - so a fixture carries the RULE rather than a number.
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { HOSTED } from './plugins/hosted.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
const b32 = (n) => new Uint8Array(32).fill(n);
const session = ed25519.utils.randomSecretKey();
const sessionPubkey = ed25519.getPublicKey(session);

/**
 * SIX committee keys, and the node's own makes seven - which is what the contract's 7/7 slots seat.
 *
 * It was seven here, so the contract named eight nodes for seven slots, and since §22A the round is
 * refused by name: "that round seats 8 signer nodes on 7/7 slots: 22A pays the seats the census seated,
 * and a fee lock sized for more of them pays seats that never sat". Every test in this file died on that
 * before it could carry a single receipt.
 */
const peers = Array.from({ length: 6 }, () => ed25519.utils.randomSecretKey());
const peerKeys = peers.map((k) => schnorr.getPublicKey(k));

const contract = (nodes) => ({
  networkId: b32(0x4e), configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH, startTimeMs: 60500n, entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients),
  censusHeight: 900000, censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash',
  stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: BLOCK_TICKS,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes,
});
const entryFor = (rid) => ({
  roundId: rid, playerPubkey: b32(5), sessionPubkey,
  stakeCommitment: b32(7), stakeMsat: 100000n, feeMsat: entryFeeMsat(100000n), donationMsat: 0n, joinTick: 0, worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
});

const signedMark = (c) => joinSigned(encodeCheckpoint(c), ed25519.sign(checkpointId(c), session));
const receiptFrom = (secret, id, ms) => {
  const r = { checkpointId: id, nodePubkey: schnorr.getPublicKey(secret), receivedAtMs: ms };
  return joinSignedReceipt(encodeCheckpointReceipt(r), schnorr.sign(receiptId(r), secret));
};

/**
 * A round with marks at 60 and 120, and a batch of 200 ticks under them.
 *
 * `carried` is how many DISTINCT committee members end up having receipted
 * each mark, counting the node's own: storing a checkpoint issues one, so the
 * floor is 1 and the peers make up the difference. Measured while writing
 * this - four peer receipts read as five members, because the node had already
 * signed one.
 */

// kanban #1489 round 3 (play): THE SEAT REPLAYS ONE RUN AND SIGNS ANOTHER.
// round.batch stores a batch's events in tables keyed (round, entry, tick) with INSERT OR IGNORE - the FIRST event at a
// tick is kept. The canonical transcript (whose hash the seat signs, and which an objection carries) holds the batch
// bytes themselves, and replayFormOf -> the core's eventsOf keeps the LAST event at a tick (a Map, sorted ascending:
// the larger). So a batch carrying two liquidations at one tick is replayed by every seat with the small strike, and by
// any objection checker with the large one. Safe: the inputs a seat replays are the inputs of the transcript it signs
// (or such a batch is refused at intake).
function setup(liquidations, loads = []) {
  const round = new Round(openStore(), () => 1234, { plugins: HOSTED });
  const c = contract([...peerKeys, round.identity.pubkey]);
  const rid = round.open(c);
  assumeAssigned(round, rid, c.nodes);
  const eid = round.enter(entryFor(rid));
  const words = Array.from({ length: 200 }, () => [0, 0, 0, 0, 0]);
  const batch = { roundId: rid, entryId: eid, firstTick: 0, previousHash: GENESIS, ticks: words, liquidations, loads };
  let refused = null;
  try { round.batch(encodeInputBatch(batch)); } catch (e) { refused = e.message; }
  if (refused) return { refused };
  const mark = { roundId: rid, entryId: eid, tick: 120, stateHash: b32(9), inputChainHash: batchId(batch), previousHash: NO_PREVIOUS };
  round.checkpoint(signedMark(mark));
  for (let i = 0; i < 6; i++) round.takeReceipt(receiptFrom(peers[i], checkpointId(mark), 1000n + BigInt(i)));
  const canonical = round.canonicalTranscript(rid, eid);
  return { seat: round.transcript(rid, eid), objection: replayFormOf(decodeTranscript(canonical.bytes)) };
}
const strikeAt = (form, tick) => new Map((form.liquidations || []).map(([at, size]) => [at, size])).get(tick);

test('#1489-r3-play-1: two liquidations at one tick - the seat replays the strike the signed transcript does not carry', () => {
  const small = 1 << 16, large = 40 << 16;
  const got = setup([[50, small], [50, large]]);
  if (got.refused) return;   // refused at intake: safe
  console.log('seat replays liquidations', JSON.stringify(got.seat.liquidations), '| canonical/objection form', JSON.stringify(got.objection.liquidations));
  console.log('core eventsOf strike at 50: seat', strikeAt(got.seat, 50), 'canonical', strikeAt(got.objection, 50));
  assert.equal(CORE.eventsOf(got.seat).count.liquidations, CORE.eventsOf(got.objection).count.liquidations);
  assert.equal(strikeAt(got.seat, 50), strikeAt(got.objection, 50),
    'the strike every seat replays differs from the strike the canonical transcript (signed hash, objection bundle) replays');
});

test('#1489-r3-play-1b: two loads at one tick - same split for the load the war hunts by', () => {
  const got = setup([], [[10, 100, 1], [10, 900000, 9999]]);
  if (got.refused) return;
  const at = (form) => JSON.stringify(new Map((form.loads || []).map(([t, ...r]) => [t, r])).get(10));
  console.log('load at 10: seat', at(got.seat), 'canonical', at(got.objection));
  assert.equal(at(got.seat), at(got.objection));
});
