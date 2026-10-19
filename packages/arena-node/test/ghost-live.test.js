// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE PICTURE HAS TO KEEP UP WITH THE TRUCK THAT IS DRIVING.
//
// Letter 28 got a ghost drawn. the owner, 09:44: two tabs see the other truck at
// spawn and then it does not follow - frames land rarely, it stutters, it is
// not realtime. Measured before this file existed, one frame of one watcher:
//
//     tick     5    11.8 ms
//     tick  1085    94.6 ms      the whole 100 ms budget, eighteen seconds in
//     tick  3599   568.9 ms      five batches behind, per watcher
//
// A driver publishes every 100 ms (`BatchEvery` is 6 ticks at 60 Hz), so the
// picture kept up for about eighteen seconds and then fell behind for good.
// Every frame replayed the run from tick zero.
//
// A GHOST IS STILL A PICTURE (0.10). Nothing here is an input to anybody's
// simulation, nothing is computed in a browser, and the pose still comes off
// the node replaying the transcript it stored. What changed is that the ticks
// already stepped are not stepped again.
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH } from '../../nextblock/plugin/nextblock.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { test } from 'node:test';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../arena-protocol/src/donation.js';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { Ghosts, ghostForChecked, STEP_BUDGET } from '../src/ghosts.js';
import { RunInProgress } from '../src/replay.js';
import { TRUCK } from '../../nextblock/plugin/nextblock.js';
import { encodeInputBatch, batchId } from '../../arena-protocol/src/batch.js';
import { GENESIS, decodeTranscript } from '../../arena-protocol/src/transcript.js';
import { decodeGhost } from '../../arena-protocol/src/ghost.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { decodeEntryContract } from '../../arena-protocol/src/contracts.js';

// The node fee is 27A.7's 2% of the stake, and the door checks it now
// (M3.3 item 20) - so a fixture carries the RULE rather than a number.
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { HOSTED } from './plugins/hosted.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
const b32 = (n) => new Uint8Array(32).fill(n);
const BEACON = { hash: b32(0x9b), height: 900001, timeMs: 900n };
const contract = () => ({
  networkId: b32(0x4e), configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 6, gameVerifySlots: 7,
  settlementSlots: 7, gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH, startTimeMs: 60500n, entryCloseMs: 2000n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
  slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000, censusRoot: b32(2),
  committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n,
  bondMinSats: 50000n, blockTicks: BLOCK_TICKS, exposureReference: 1000, corridorHalfWidth: 40,
  spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3,
  rankDenominator: 4, nodes: [b32(4)],
});
const entryFor = (rid, joinTick = 0) => ({
  roundId: rid, playerPubkey: b32(5), sessionPubkey: b32(6), stakeCommitment: b32(7),
  stakeMsat: 100000n, feeMsat: entryFeeMsat(100000n), donationMsat: 0n, joinTick,
  worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
});
const wordsAt = (t) => [45875, ((t * 977) % 30000) - 15000, (t % 700) < 40 ? 65536 : 0, 0, 0];
// One batch per 100 ms, which is what the page actually sends.
const CHUNK = 6;

/** A round with one driver, publishing as the page does. */
function driving(ticks, { liquidations = [], loads = [], joinTick = 0 } = {}) {
  const round = new Round(openStore(':memory:'), undefined, { plugins: HOSTED });
  const rid = round.open(contract());
  const entry = entryFor(rid, joinTick);
  const eid = round.enter(entry);
  const ghosts = new Ghosts(round, { plugins: HOSTED, randomnessFor: () => BEACON });
  let previousHash = GENESIS;
  const publish = (from, n) => {
    const rows = [];
    for (let t = from; t < from + n; t++) rows.push(wordsAt(t));
    const due = liquidations.filter(([at]) => at >= from && at < from + n);
    const bed = loads.filter(([at]) => at >= from && at < from + n);
    const batch = {
      roundId: rid, entryId: eid, previousHash, firstTick: from, ticks: rows,
      liquidations: due, loads: bed,
    };
    round.batch(encodeInputBatch(batch));
    previousHash = batchId(batch);
  };
  for (let at = joinTick; at < joinTick + ticks; at += CHUNK) publish(at, CHUNK);
  return { round, rid, eid, entry, ghosts, publish, get head() { return previousHash; } };
}

/**
 * A ROUND WATCHED WHILE IT IS DRIVEN, which is the case that was broken:
 * publish a batch, ask for the newest picture, repeat. Publishing the whole
 * run first and then asking is a different question - it has one answer and
 * the cache serves it.
 */
function watchedWhileDriving(ticks, { joinTick = 0, liquidations = [], loads = [] } = {}) {
  const world = driving(0, { joinTick, liquidations, loads });
  const seen = [];
  for (let at = joinTick; at < joinTick + ticks; at += CHUNK) {
    world.publish(at, CHUNK);
    seen.push(world.ghosts.latest(world.rid, world.eid));
  }
  return { ...world, seen };
}

test('the live picture is the same pose a full replay produces, at every tick', () => {
  // THE PROPERTY THAT MATTERS. A warm run that drifted from a cold replay by
  // one word would put another player's truck somewhere they never were, and
  // it would do it silently. So the two are compared at every published tick
  // of a run, not at one.
  const world = driving(600);
  const transcript = world.round.transcript(world.rid, world.eid);
  const batches = decodeTranscript(world.round.handOver(world.rid, world.eid).bytes).batches;

  const cold = new Ghosts(world.round, { plugins: HOSTED, randomnessFor: () => BEACON });
  let compared = 0;
  for (let at = CHUNK - 1; at < 600; at += CHUNK) {
    const warm = world.ghosts.frameFor && null;   // the live path is `latest`
    void warm;
    const slow = ghostForChecked({ core: TRUCK,
      transcript, entry: world.entry, batches,
      roundId: world.rid, entryId: world.eid, tick: at, roundRandomness: BEACON.hash,
    });
    assert.equal(slow.ok, true, slow.why);
    const fast = cold.frameFor(world.rid, world.eid, at);
    assert.equal(fast.ok, true, fast.why);
    assert.equal(toHex(fast.bytes), toHex(slow.bytes), `tick ${at} differs from a full replay`);
    compared++;
  }
  assert.equal(compared, 100);
});

test('the warm run walks each tick once, however many frames it makes', () => {
  const world = watchedWhileDriving(600);
  for (const made of world.seen) assert.equal(made.ok, true, made.why);
  assert.equal(world.seen.length, 100, 'a batch went out without a picture following it');

  // ONE PASS OVER THE RUN, NOT ONE PER FRAME. Before this, 100 frames of a
  // 600-tick run stepped 30,300 ticks; the run is 600 ticks long.
  assert.equal(world.ghosts.walked, 600,
    'the live path stepped more ticks than the run has');
  assert.equal(world.ghosts.made, 100, 'a frame was served from cache while the truck was moving');
});

test('the pose a watcher is shown is this tick\'s, not the spawn pose', () => {
  const world = watchedWhileDriving(600);
  const first = world.seen[world.seen.length - 1];
  assert.equal(first.ok, true, first.why);
  const shown = decodeGhost(first.bytes);
  assert.equal(shown.tick, 599, 'the newest picture is not of the newest tick');

  // AND IT MOVES. The complaint was a truck at spawn that never followed, so
  // the measurement is that consecutive pictures are different poses.
  const poses = new Set();
  for (let n = 0; n < 5; n++) {
    world.publish(600 + n * CHUNK, CHUNK);
    const made = world.ghosts.latest(world.rid, world.eid);
    assert.equal(made.ok, true, made.why);
    const g = decodeGhost(made.bytes);
    assert.equal(g.tick, 605 + n * CHUNK);
    poses.add(`${g.x}:${g.z}:${g.heading}`);
  }
  assert.equal(poses.size, 5, 'the truck was drawn in the same place five times running');
});

test('a liquidation lands before its own tick, and exactly once', () => {
  // The one piece of state a resumable run could get wrong twice: a strike
  // applied on every step-forward would be a different world from the replay.
  const withStrike = watchedWhileDriving(300, { liquidations: [[37, 3 * 65536]] });
  const cold = new Ghosts(withStrike.round, { plugins: HOSTED, randomnessFor: () => BEACON });

  const live = withStrike.seen[withStrike.seen.length - 1];
  const slow = cold.frameFor(withStrike.rid, withStrike.eid, 299);
  assert.equal(live.ok, true, live.why);
  assert.equal(slow.ok, true, slow.why);
  assert.equal(toHex(live.bytes), toHex(slow.bytes),
    'the strike landed a different number of times in the warm run');
});

test('a late joiner\'s picture starts at their own join tick', () => {
  const world = watchedWhileDriving(300, { joinTick: 1200 });
  const made = world.seen[world.seen.length - 1];
  assert.equal(made.ok, true, made.why);
  assert.equal(decodeGhost(made.bytes).tick, 1499);
  assert.equal(world.ghosts.walked, 300, 'a late joiner replayed ticks before they joined');
});

test('a run refuses to be stepped past the end of a round, and past a gap', () => {
  const world = driving(60);
  const run = new RunInProgress(world.entry, { core: TRUCK, roundRandomness: BEACON.hash });
  assert.equal(run.ok, true, run.why);

  const whole = world.round.ticksFrom(world.rid, world.eid, 0);
  // THE END COMES FROM THE ROUND'S OWN LENGTH, not from a number typed once: 8999 was the last tick of a
  // 9000-tick round, and the core's round is 10800 long.
  const past = BLOCK_TICKS + 1000;
  assert.equal(run.stepTo(whole, past).ok, false);
  assert.match(run.stepTo(whole, past).why, new RegExp(`that run ends at tick ${BLOCK_TICKS - 1}`));
  assert.match(run.stepTo(whole, 600).why, /is not one the published inputs cover/);

  // A SLICE THAT SKIPS AHEAD IS NOT A LONGER RUN.
  const ahead = world.round.ticksFrom(world.rid, world.eid, 30);
  assert.equal(ahead.from, 30);
  const fresh = new RunInProgress(world.entry, { core: TRUCK, roundRandomness: BEACON.hash });
  assert.equal(fresh.stepTo(ahead, 40).ok, false);
  assert.match(fresh.stepTo(ahead, 40).why, /this run is at tick -1 and that slice starts at 30/);
});

test('a round with no randomness shows nobody anything, in the same words as before', () => {
  const round = new Round(openStore(':memory:'), undefined, { plugins: HOSTED });
  const rid = round.open(contract());
  const entry = entryFor(rid);
  const eid = round.enter(entry);
  const batch = { roundId: rid, entryId: eid, previousHash: GENESIS, firstTick: 0,
    ticks: [wordsAt(0)], liquidations: [] };
  round.batch(encodeInputBatch(batch));

  const blind = new Ghosts(round, { plugins: HOSTED, randomnessFor: () => undefined });
  const seen = blind.latest(rid, eid);
  assert.equal(seen.ok, false);
  assert.match(seen.why, /no randomness yet/);
});

/**
 * AND THE LOAD, WHICH IS WHAT LETTER 40 REOPENED 36 FOR.
 *
 * This is the LIVE path - the one every watcher's picture comes off - and it
 * kept its own warm state. Until letter 40 nothing on it applied a load,
 * because nothing anywhere carried one: the page wrote the heat into its own
 * core through `ArenaSetHeat` and no batch, mark or transcript held it. So a
 * watcher was shown a truck driven with an empty bed while its driver was
 * being hunted for a full one, and the two part further with every tick.
 */
const BED = [[0, 17314, 42]];      // an AUTO load; reads 57229 in the core

test('a live picture of a loaded run is the pose a full replay produces', () => {
  const world = driving(600, { loads: BED });
  const transcript = world.round.transcript(world.rid, world.eid);
  const batches = decodeTranscript(world.round.handOver(world.rid, world.eid).bytes).batches;
  assert.deepEqual(transcript.loads, BED, 'the node did not store the load');

  const cold = new Ghosts(world.round, { plugins: HOSTED, randomnessFor: () => BEACON });
  let compared = 0;
  for (let at = CHUNK - 1; at < 600; at += CHUNK) {
    const slow = ghostForChecked({ core: TRUCK,
      transcript, entry: world.entry, batches,
      roundId: world.rid, entryId: world.eid, tick: at, roundRandomness: BEACON.hash,
    });
    assert.equal(slow.ok, true, slow.why);
    const fast = cold.frameFor(world.rid, world.eid, at);
    assert.equal(fast.ok, true, fast.why);
    assert.equal(toHex(fast.bytes), toHex(slow.bytes), `tick ${at} differs from a full replay`);
    compared++;
  }
  assert.equal(compared, 100);

});

/**
 * AND THE LOAD IS WHAT MAKES THE PICTURE DIFFERENT, or the agreement above is
 * two runs of the same thing.
 *
 * Nine hundred ticks, because that is how long this drive takes to reach the
 * army: heat widens the range a tank notices the truck at, so an empty bed and
 * a full one are the same drive until the first gun is in reach and part for
 * good after it.
 */
test('the load is what moves the picture, and by how much', () => {
  const loaded = driving(900, { loads: BED });
  const empty = driving(900);
  const a = new Ghosts(loaded.round, { plugins: HOSTED, randomnessFor: () => BEACON })
    .frameFor(loaded.rid, loaded.eid, 899);
  const b = new Ghosts(empty.round, { plugins: HOSTED, randomnessFor: () => BEACON })
    .frameFor(empty.rid, empty.eid, 899);
  assert.equal(a.ok, true, a.why);
  assert.equal(b.ok, true, b.why);
  const apart = Math.hypot((a.ghost.x - b.ghost.x) / 65536, (a.ghost.z - b.ghost.z) / 65536);
  console.log(`  at tick 899 the loaded run is drawn ${apart.toFixed(3)} m from the same inputs unloaded`
    + ` | loaded x ${(a.ghost.x / 65536).toFixed(2)} z ${(a.ghost.z / 65536).toFixed(2)}`
    + ` | empty x ${(b.ghost.x / 65536).toFixed(2)} z ${(b.ghost.z / 65536).toFixed(2)}`);
  assert.ok(apart > 1,
    `a load moved this drive ${apart.toFixed(3)} m, which is not enough to be the fault`);
});

test('a load is applied once however many slices a watcher asks for', () => {
  // The node serves the loads WHOLE beside a slice - a load declared at
  // roll-out is in every slice a live watcher reads - so applying one per
  // slice would compound it. The warm run's answer must be the cold one's.
  const live = watchedWhileDriving(600, { loads: BED });
  assert.equal(live.seen.length, 100);
  const last = live.seen[live.seen.length - 1];
  assert.equal(last.ok, true, last.why);

  const transcript = live.round.transcript(live.rid, live.eid);
  const batches = decodeTranscript(live.round.handOver(live.rid, live.eid).bytes).batches;
  const slow = ghostForChecked({ core: TRUCK,
    transcript, entry: live.entry, batches,
    roundId: live.rid, entryId: live.eid, tick: last.ghost.tick, roundRandomness: BEACON.hash,
  });
  assert.equal(slow.ok, true, slow.why);
  assert.equal(toHex(last.bytes), toHex(slow.bytes),
    'a hundred slices produced a different pose from one replay');
  console.log(`  100 slices, load in every one of them, and tick ${last.ghost.tick} `
    + `is byte-identical to a cold replay`);
});

test('a truck already far into its run does not stop the node: each picture replays at most STEP_BUDGET ticks, and the pictures catch up', () => {
  // 2026-09-17 17:05 / 17:12: ghosts a minute late. Measured on the Daily's signer-node process: 18.7 s and 20.0 s
  // with no answer within one minute - the first picture of a truck replayed its whole run on the shared event loop.
  const TICKS = 6000;
  const { round, rid, eid, ghosts } = driving(TICKS);
  let worst = 0, calls = 0, last = null;
  while (calls < 200) {
    const t0 = performance.now();
    const made = ghosts.latest(rid, eid);
    worst = Math.max(worst, performance.now() - t0);
    calls++;
    assert.equal(made.ok, true, made.why);
    last = made.ghost.tick;
    if (last === TICKS - 1) break;
  }
  const exact = ghostForChecked({ core: TRUCK, transcript: round.transcript(rid, eid), entry: decodeEntryContract(round.entry(eid)),
    batches: decodeTranscript(round.handOver(rid, eid).bytes).batches, roundId: rid, entryId: eid, tick: TICKS - 1, roundRandomness: BEACON.hash });
  console.log(`  a truck at tick ${TICKS - 1}: ${calls} pictures to catch up, the slowest call ${worst.toFixed(0)} ms (${STEP_BUDGET} ticks a call)`);
  assert.equal(last, TICKS - 1, 'the pictures never caught up with the published tick');
  assert.ok(calls <= Math.ceil(TICKS / STEP_BUDGET) + 1, `${calls} calls to catch up`);
  assert.ok(worst < 400, `one picture held the node ${worst.toFixed(0)} ms`);
  assert.equal(exact.ok, true, exact.why);
  const caught = decodeGhost(ghosts.latest(rid, eid).bytes);
  assert.deepEqual([caught.x, caught.z, caught.heading], [exact.ghost.x, exact.ghost.z, exact.ghost.heading], 'the caught-up picture is not where a full replay puts the truck');
});
