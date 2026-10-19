// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE LIVE PRICE ON THE SIGNER NODES (2026-09-17 16:01): price samples ride the batch beside their ticks, the node
// stores and serves them, and a replay reaches the state of the page that fought on the moving chart.
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH } from '../../nextblock/plugin/nextblock.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { test } from 'node:test';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../arena-protocol/src/donation.js';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { replay as replayUnder } from '../src/replay.js';
import { TRUCK } from '../../nextblock/plugin/nextblock.js';
// THE TRUCK'S RUNS, REPLAYED UNDER THE TRUCK (M3 R1): replay takes the core it runs under; these are truck runs.
const replay = (t, e, o = {}) => replayUnder(t, e, { core: TRUCK, ...o });
import { init, step, submitSample, submitTape } from '../../nextblock/src/sim.js';
import { hash, O_TRUCK, T_X, T_Z } from '../../nextblock/src/state.js';
import { encodeInputBatch, batchId } from '../../arena-protocol/src/batch.js';
import { GENESIS } from '../../arena-protocol/src/transcript.js';

// The node fee is 27A.7's 2% of the stake, and the door checks it now
// (M3.3 item 20) - so a fixture carries the RULE rather than a number.
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { HOSTED } from './plugins/hosted.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
const ONE = 65536;
const b32 = (n) => new Uint8Array(32).fill(n);
const SEED = 1;


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

/** A drive that goes up the field and into the army's reach. */
const wordsAt = () => [45875, 6000, 0, 0, 0];

// Three live BTCUSD prices in the tape's unit (256 a dollar), one every 300 ticks, as CoreDrivenTruck submits them.
const SAMPLES = [[300, Math.round(76727.4 * 256)], [600, Math.round(76811.9 * 256)], [900, Math.round(76502.2 * 256)]];

// The live tape a page fetched at the start (the owner 16:44): 64 prices 5 s apart, handed over at tick 0.
const TAPE = Array.from({ length: 64 }, (_, i) => Math.round((76690 + 11 * Math.sin(i / 4) + i * 0.3) * 256));

/** The player's own run: the page hands its core the live tape and each price before the tick it belongs to. */
function played(ticks, samples = SAMPLES, tape = null) {
  const st = init(SEED), due = new Map(samples);
  for (let t = 0; t < ticks; t++) {
    if (tape && t === 0) submitTape(st, tape);
    if (due.has(t)) submitSample(st, due.get(t));
    step(st, ...wordsAt(t));
  }
  return st;
}

/** The same run through the daemon's door: batches in (the samples beside the ticks they name), transcript out. */
function stored(ticks, { chunk = 100, samples = SAMPLES, tape = null } = {}) {
  const r = new Round(openStore(), () => 1234, { plugins: HOSTED });
  const rid = r.open(contract());
  const entry = entryFor(rid);
  const eid = r.enter(entry);
  let previousHash = GENESIS;
  for (let i = 0; i < ticks; i += chunk) {
    const n = Math.min(chunk, ticks - i);
    const b = {
      roundId: rid, entryId: eid, previousHash, firstTick: i, ticks: Array.from({ length: n }, (_, k) => wordsAt(i + k)),
      liquidations: [], loads: [], samples: samples.filter(([at]) => at >= i && at < i + n),
      tapes: tape && i === 0 ? [[0, ...tape]] : [],
    };
    assert.equal(r.batch(encodeInputBatch(b)), n, 'the node did not store every tick');
    previousHash = batchId(b);
  }
  return { round: r, rid, eid, entry, transcript: r.transcript(rid, eid) };
}

/**
 * THE CHART MOVES ON THE SIGNER NODES TOO (2026-09-17 16:01: "no new candles coming in" - nothing had ever
 * submitted a price sample). A sample moves the tape, the candles, the seam and the market the army reads, so it is in
 * the batch beside its tick, the node stores it, the transcript carries it and the replay reaches the player's state.
 */
test('live price samples are in the transcript, so a replay reaches the player\'s own moving chart', () => {
  const TICKS = 1200;
  const run = played(TICKS);
  assert.equal(run.tape[run.tape.length - 1], SAMPLES[2][1], 'the page\'s tape did not take the last price');
  const { round, rid, eid, transcript, entry } = stored(TICKS);
  assert.deepEqual(transcript.samples, SAMPLES, 'the node did not store the samples');
  assert.deepEqual(round.ticksFrom(rid, eid, 600).samples, SAMPLES.slice(1), 'a live slice does not carry the samples from its tick on');

  const got = replay(transcript, entry, { seedWord: SEED });
  assert.equal(got.ok, true, got.why);
  assert.equal(got.samples, 3);
  assert.equal(got.stateHash, hash(run), 'the replay reached a different state');

  // and without them the replay is the frozen chart - a different war
  const blind = played(TICKS, []);
  const { transcript: t2, entry: e2 } = stored(TICKS, { samples: [] });
  const without = replay(t2, e2, { seedWord: SEED });
  assert.equal(without.ok, true, without.why);
  assert.equal(without.samples, 0);
  assert.equal(without.stateHash, hash(blind));
  assert.notEqual(without.stateHash, hash(run), 'the samples changed nothing, so this measures nothing');
  const apart = Math.hypot((run.i32[O_TRUCK + T_X] - blind.i32[O_TRUCK + T_X]) / ONE, (run.i32[O_TRUCK + T_Z] - blind.i32[O_TRUCK + T_Z]) / ONE);
  console.log(`  replay with the samples: the player's state hash; without them a different state (truck ${apart.toFixed(3)} m apart at tick ${TICKS})`);
});

test('the live tape is in the transcript, so a replay starts from the market the page started from, not the seed', () => {
  const TICKS = 900;
  const run = played(TICKS, SAMPLES, TAPE);
  const { round, rid, eid, transcript, entry } = stored(TICKS, { tape: TAPE });
  assert.deepEqual(transcript.tapes, [[0, ...TAPE]], 'the node did not store the tape');
  assert.deepEqual(round.ticksFrom(rid, eid, 600).tapes, [[0, ...TAPE]], 'a live slice does not carry the tape');
  const got = replay(transcript, entry, { seedWord: SEED });
  assert.equal(got.ok, true, got.why);
  assert.equal(got.tapes, 1);
  assert.equal(got.stateHash, hash(run), 'the replay of a live-taped run reached a different state');
  assert.notEqual(got.stateHash, hash(played(TICKS)), 'the tape changed nothing, so this measures nothing');
  console.log(`  a live-taped run: stored, served whole with a slice, replayed to the page's own state hash`);
});
