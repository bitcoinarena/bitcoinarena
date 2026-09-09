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
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { Ghosts, ghostForChecked } from '../src/ghosts.js';
import { RunInProgress } from '../src/replay.js';
import { encodeInputBatch, batchId } from '../../protocol/src/batch.js';
import { GENESIS, decodeTranscript } from '../../protocol/src/transcript.js';
import { decodeGhost } from '../../protocol/src/ghost.js';
import { toHex } from '../../protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const BEACON = { hash: b32(0x9b), height: 900001, timeMs: 900n };
const contract = () => ({
  networkId: b32(0x4e), configHash: b32(0x43), censusConfirmations: 6, gameVerifySlots: 7,
  settlementSlots: 7, simCoreHash: b32(1), startTimeMs: 60500n, entryCloseMs: 2000n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
  slashRemainder: 'BURN', donationSetId: b32(0xd0), censusHeight: 900000, censusRoot: b32(2),
  committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n,
  bondMinSats: 50000n, blockTicks: 9000, exposureReference: 1000, corridorHalfWidth: 40,
  spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3,
  rankDenominator: 4, nodes: [b32(4)],
});
const entryFor = (rid, joinTick = 0) => ({
  roundId: rid, playerPubkey: b32(5), sessionPubkey: b32(6), stakeCommitment: b32(7),
  stakeMsat: 100000n, feeMsat: 1000n, donationMsat: 0n, joinTick,
  worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32),
});
const wordsAt = (t) => [45875, ((t * 977) % 30000) - 15000, (t % 700) < 40 ? 65536 : 0, 0, 0];
// One batch per 100 ms, which is what the page actually sends.
const CHUNK = 6;

/** A round with one driver, publishing as the page does. */
function driving(ticks, { liquidations = [], joinTick = 0 } = {}) {
  const round = new Round(openStore(':memory:'));
  const rid = round.open(contract());
  const entry = entryFor(rid, joinTick);
  const eid = round.enter(entry);
  const ghosts = new Ghosts(round, { randomnessFor: () => BEACON });
  let previousHash = GENESIS;
  const publish = (from, n) => {
    const rows = [];
    for (let t = from; t < from + n; t++) rows.push(wordsAt(t));
    const due = liquidations.filter(([at]) => at >= from && at < from + n);
    const batch = { roundId: rid, entryId: eid, previousHash, firstTick: from, ticks: rows, liquidations: due };
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
function watchedWhileDriving(ticks, { joinTick = 0, liquidations = [] } = {}) {
  const world = driving(0, { joinTick, liquidations });
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

  const cold = new Ghosts(world.round, { randomnessFor: () => BEACON });
  let compared = 0;
  for (let at = CHUNK - 1; at < 600; at += CHUNK) {
    const warm = world.ghosts.frameFor && null;   // the live path is `latest`
    void warm;
    const slow = ghostForChecked({
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
  const cold = new Ghosts(withStrike.round, { randomnessFor: () => BEACON });

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
  const run = new RunInProgress(world.entry, { roundRandomness: BEACON.hash });
  assert.equal(run.ok, true, run.why);

  const whole = world.round.ticksFrom(world.rid, world.eid, 0);
  assert.equal(run.stepTo(whole, 9999).ok, false);
  assert.match(run.stepTo(whole, 9999).why, /that run ends at tick 8999/);
  assert.match(run.stepTo(whole, 600).why, /is not one the published inputs cover/);

  // A SLICE THAT SKIPS AHEAD IS NOT A LONGER RUN.
  const ahead = world.round.ticksFrom(world.rid, world.eid, 30);
  assert.equal(ahead.from, 30);
  const fresh = new RunInProgress(world.entry, { roundRandomness: BEACON.hash });
  assert.equal(fresh.stepTo(ahead, 40).ok, false);
  assert.match(fresh.stepTo(ahead, 40).why, /this run is at tick -1 and that slice starts at 30/);
});

test('a round with no randomness shows nobody anything, in the same words as before', () => {
  const round = new Round(openStore(':memory:'));
  const rid = round.open(contract());
  const entry = entryFor(rid);
  const eid = round.enter(entry);
  const batch = { roundId: rid, entryId: eid, previousHash: GENESIS, firstTick: 0,
    ticks: [wordsAt(0)], liquidations: [] };
  round.batch(encodeInputBatch(batch));

  const blind = new Ghosts(round, { randomnessFor: () => undefined });
  const seen = blind.latest(rid, eid);
  assert.equal(seen.ok, false);
  assert.match(seen.why, /no randomness yet/);
});
