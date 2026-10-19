// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A LIVE GHOST IS THE POSE THE TRANSCRIPT REPLAYS TO (2026-09-18 12:02: "Drawn pose must match the other
// client's truck").
//
// Measured on the Daily before this test existed: a watcher's pictures sat exactly on a cold replay of the same
// transcript for the first half of a run - p50 0.000 m over 576 pictures - and then walked away from it, p50 14.2 m
// over the second half, p90 80 m, max 115 m, first parting at tick 5285 by 0.561 m. The node's own `replay()` and a
// bare core stepped with the same words agreed with each other at every sampled tick, so the odd one out was the LIVE
// path: `RunInProgress`, which keeps a run warm and steps it forward in slices rather than replaying it from the
// join. The node's stored transcript carried 9000 ticks and no liquidation, load, sample or tape, so no market event
// explains it.
//
// This drives the same two paths with no daemon and no network: one transcript, a cold replay for the poses, and a
// warm run stepped in slices the size the live pusher uses. They must be the same pose at every tick.
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { replay, RunInProgress } from '../src/replay.js';
import { TRUCK, TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH } from '../../nextblock/plugin/nextblock.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { Ghosts } from '../src/ghosts.js';
import { Round } from '../src/round.js';
import { openStore } from '../src/store.js';
import { encodeInputBatch, batchId } from '../../arena-protocol/src/batch.js';
import { GENESIS } from '../../arena-protocol/src/transcript.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../arena-protocol/src/donation.js';
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { seedWordForEntry } from '../../arena-protocol/src/seed.js';
import { HOSTED } from './plugins/hosted.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const JOIN = 0;
const TICKS = 3000;
const SLICE = 150;                       // STEP_BUDGET: what one live call steps at most

/** A run that turns and accelerates, so a pose at tick N is not a pose at tick N-1. */
const words = (t) => [65536, Math.sin(t / 240) > 0 ? 16384 : -16384, 0, 0, 0];
const transcript = {
  ticks: Array.from({ length: TICKS }, (_, i) => ({ tick: JOIN + i, words: words(i) })),
  liquidations: [], loads: [], samples: [], tapes: [],
};
const entry = { joinTick: JOIN };
const SEED = 1855654319 | 0;

test('the warm run a live ghost is served from is the same pose as a cold replay of the same transcript', () => {
  const at = [];
  for (let t = 200; t < TICKS; t += 97) at.push(t);

  const cold = replay(transcript, entry, { core: TRUCK, seedWord: SEED, pictures: at });
  assert.equal(cold.ok, true, cold.why);
  assert.equal(cold.pictures.length, at.length, 'the cold replay did not picture every tick asked for');

  // THE WARM RUN, stepped the way the live pusher steps it: a slice at a time, each slice handed the ticks it has not
  // stepped yet - which is what `Ghosts.latest` does with `ticksFrom(run.at + 1)`.
  const warm = new RunInProgress(entry, { core: TRUCK, seedWord: SEED });
  const got = new Map();
  // ASKED FOR THE VERY TICKS THE COLD REPLAY PICTURED, a step at a time, which is what a live watcher's pushes do:
  // `latest` steps the warm run to whatever tick the driver has published and pictures it there.
  for (const to of at) {
    const from = warm.at + 1;
    const slice = { from, ticks: transcript.ticks.slice(from - JOIN, to - JOIN + 1), liquidations: [], loads: [], samples: [], tapes: [] };
    const r = warm.stepTo(slice, to);
    assert.equal(r.ok, true, `the warm run refused a slice to tick ${to}: ${r.why}`);
    got.set(to, { x: r.x, z: r.z, heading: r.heading });
  }

  // AND THE SAME TICKS, BOTH WAYS. A pose is three integers; there is no tolerance to argue about.
  const warmAt = (tick) => got.get(tick);
  let worst = { apart: 0, tick: null };
  for (const shot of cold.pictures) {
    const mine = warmAt(shot.tick);
    if (!mine) continue;
    const apart = Math.hypot((mine.x - shot.x) / 65536, (mine.z - shot.z) / 65536);
    if (apart > worst.apart) worst = { apart, tick: shot.tick };
  }
  // The slices land on their own ticks, so compare where both have one.
  const both = cold.pictures.filter((s) => warmAt(s.tick));
  console.log(`[warm-ghost] ${both.length} ticks held by both paths; worst ${worst.apart.toFixed(3)} m at tick ${worst.tick}`);
  assert.ok(both.length > 0, 'the two paths shared no tick, so this compares nothing');
  assert.equal(worst.apart, 0,
    `a live ghost is ${worst.apart.toFixed(3)} m from what the transcript replays to, at tick ${worst.tick}`);
});

test('a warm run stepped one tick at a time is the same pose as one stepped in slices', () => {
  // The live path's slice boundaries fall where the batches do, which is not where a cold replay's do. If stepping
  // 150 ticks at once and stepping them one at a time differ, the boundary itself is the fault.
  const bySlice = new RunInProgress(entry, { core: TRUCK, seedWord: SEED });
  const byTick = new RunInProgress(entry, { core: TRUCK, seedWord: SEED });
  const upTo = 900;
  for (let to = SLICE - 1; to < upTo; to += SLICE) {
    const from = bySlice.at + 1;
    bySlice.stepTo({ from, ticks: transcript.ticks.slice(from, to + 1), liquidations: [], loads: [], samples: [], tapes: [] }, to);
  }
  for (let to = 0; to < upTo; to++) {
    const from = byTick.at + 1;
    byTick.stepTo({ from, ticks: transcript.ticks.slice(from, to + 1), liquidations: [], loads: [], samples: [], tapes: [] }, to);
  }
  const a = bySlice.pose(), b = byTick.pose();
  console.log(`[warm-ghost] at tick ${a.tick}/${b.tick}: by slice (${a.x}, ${a.z}) by tick (${b.x}, ${b.z})`);
  assert.equal(a.tick, b.tick, 'the two warm runs are not at the same tick');
  assert.equal(a.x, b.x, 'a run stepped in slices is at another x than one stepped tick by tick');
  assert.equal(a.z, b.z, 'a run stepped in slices is at another z than one stepped tick by tick');
  assert.equal(a.heading, b.heading, 'a run stepped in slices faces another way than one stepped tick by tick');
});

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

test('the pose a live push loop serves is the pose the stored transcript replays to', () => {
  // THE LIVE FEED, not the warm run on its own: batches of six ticks as the page sends them, `latest()` after each,
  // and so the real `ticksFrom` slices, the real frame cache and the real reuse of a warm run. Measured on the Daily,
  // this is where the picture left the transcript: p50 0.000 m for the first half of a run and 14.2 m for the second,
  // first parting at tick 5285 by 0.561 m, with the node's own transcript carrying no liquidation, load, sample or
  // tape to explain it.
  const TICKS = 6000;
  const world = driving(0);                       // a round and an entry, nothing published yet
  const seen = new Map();
  let rebuilds = 0, lastRun = null, servedOlder = 0;
  for (let at = 0; at < TICKS; at += CHUNK) {
    world.publish(at, CHUNK);
    // WHAT THE SERVER DOES ON EVERY BATCH: walk the warm run up to what has been published, a slice at a time.
    for (let slice = 0; slice < 8; slice++) {
      const made = world.ghosts.latest(world.rid, world.eid);
      assert.equal(made.ok, true, made.why);
      const run = world.ghosts.runs && world.ghosts.runs.get([...world.ghosts.runs.keys()][0]);
      if (run && run !== lastRun) { rebuilds++; lastRun = run; }
      if (seen.has(made.ghost.tick)) servedOlder++;
      seen.set(made.ghost.tick, { x: made.ghost.x, z: made.ghost.z });
      if (made.ghost.tick >= at + CHUNK - 1) break;
    }
  }

  const at = [...seen.keys()].filter((k) => k >= 200).sort((a, b) => a - b).filter((_, i) => i % 13 === 0);
  const transcript = {
    ticks: Array.from({ length: TICKS }, (_, i) => ({ tick: i, words: wordsAt(i) })),
    liquidations: [], loads: [], samples: [], tapes: [],
  };
  const seedWord = seedWordForEntry(world.entry, BEACON.hash);
  const cold = replay(transcript, world.entry, { core: TRUCK, seedWord, pictures: at });
  assert.equal(cold.ok, true, cold.why);

  let worst = { apart: 0, tick: null };
  let compared = 0;
  for (const shot of cold.pictures) {
    const live = seen.get(shot.tick);
    if (!live) continue;
    compared++;
    const apart = Math.hypot((live.x - shot.x) / 65536, (live.z - shot.z) / 65536);
    if (apart > worst.apart) worst = { apart, tick: shot.tick };
  }
  console.log(`[warm-ghost] live push loop: ${seen.size} ticks pictured, ${compared} of ${cold.pictures.length} `
    + `compared, ${rebuilds} run rebuild(s), ${servedOlder} repeats; worst ${worst.apart.toFixed(3)} m at tick ${worst.tick}`);
  // A COUNT, BECAUSE "worst 0.000 m" READS THE SAME WHEN NOTHING WAS COMPARED.
  assert.ok(compared >= 20, `only ${compared} ticks were compared, so this proves nothing`);
  assert.equal(worst.apart, 0,
    `a live ghost is ${worst.apart.toFixed(3)} m from what the transcript replays to, at tick ${worst.tick}`);
});
