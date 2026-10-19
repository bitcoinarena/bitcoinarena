// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SEED SLICE (IMPLEMENTATION.md §12.1, RULED 2026-09-25): the node and the fixtures read the round's beacon
// from the bonded chain, and players and the node seed the world from that same hash. Measured here only what does not
// depend on who delivers:
//   1. every holder names the same beacon - the bonded chain's own block, and another round's chain names another;
//   2. the seed and the committee both derive from it - the roster's committee seed is committeeSeedFromBeacon over that
//      hash, and the player's mark, seeded from it, is the state the node's own stored transcript replays to;
//   3. a round on a fixed beacon replays bit-identically - the same contract mines the same beacon again, and every
//      replay of a holder's stored transcript under it reaches the same state, outcome and score.
// No run here is asked to deliver: the recorded tape (wordsAt) was recorded on another world, and a test that needs a
// specific scripted entry to deliver on a beacon-seeded round is a listed red of this slice (TASKBOOK).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { bondedChainSlot, bondedChainFor } from './lock-fixture.js';
import { LOSER, RANDOMNESS, wordsAt, loaded } from './window-fixture.js';
import { beaconFromChain, committeeSeedFromBeacon } from '../../arena-protocol/src/beacon.js';
import { seedWordForEntry } from '../../arena-protocol/src/seed.js';
import { decodeCheckpoint, CHECKPOINT_BYTES, SIGNED_CHECKPOINT_BYTES } from '../../arena-protocol/src/checkpoint.js';
import { coreOfGame } from '../src/plugins.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { replay } from '../src/replay.js';
import { init, step } from '../../nextblock/src/sim.js';
import { hash as stateHash } from '../../nextblock/src/state.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const named = async (d, rid) => {
  const r = await fetch(`http://127.0.0.1:${d.port}/randomness?round=${toHex(rid)}`);
  return { status: r.status, height: r.headers.get('x-height'), hash: toHex(new Uint8Array(await r.arrayBuffer())) };
};
const coreOf = (c) => { const found = coreOfGame(c, NEXTBLOCK); assert.equal(found.ok, true, found.why); return { ...found.core, config: found.config }; };
const marksAt = (d, w, eid) => {
  const { bytes, count } = d.round.checkpoints(w.rid, eid);
  return Array.from({ length: count }, (_, i) => decodeCheckpoint(bytes.subarray(i * SIGNED_CHECKPOINT_BYTES, i * SIGNED_CHECKPOINT_BYTES + CHECKPOINT_BYTES)));
};

test('1. every holder names the same beacon: the bonded chain\'s own block, not the fixtures\' constant, and another round names another', async () => {
  const w = await lockRound();
  const v = await lockRound();
  try {
    const view = w.slot.chainWith(w.c);
    const chain = beaconFromChain(w.c, { headers: view.blocks.map((b) => b.header), firstHeight: view.firstHeight });
    const facts = { a: await named(w.a, w.rid), b: await named(w.b, w.rid), chain: { hash: toHex(chain.hash), height: String(chain.height) },
      player: toHex(w.randomness), other: (await named(v.a, v.rid)).hash };
    console.log('  FACTS (beacon):', JSON.stringify(facts));
    assert.equal(facts.a.status, 200);
    assert.deepEqual(facts.b, facts.a, 'the round\'s two holders name different beacons');
    assert.deepEqual({ hash: facts.a.hash, height: facts.a.height }, facts.chain, 'a holder\'s beacon is not the bonded chain\'s');
    assert.equal(facts.player, facts.a.hash, 'the player seeds from another hash than the holders name');
    assert.notEqual(facts.a.hash, toHex(RANDOMNESS), 'the beacon is still the fixtures\' constant');
    assert.notEqual(facts.other, facts.a.hash, 'two rounds on two chains name one beacon');
  } finally { await w.close(); await v.close(); }
});

test('2. the committee seed and the world seed both derive from that beacon: the holders\' roster seed is its seed, and the mark seeded from it is what the stored transcript replays to', async () => {
  const w = await lockRound();
  try {
    const played = await lockAndPlay(w, LOSER);
    const beacon = w.slot.randomnessFor({ contract: w.c });
    const fromBeacon = committeeSeedFromBeacon(w.c, { roundId: w.rid, randomness: beacon.hash, height: beacon.height, timeMs: beacon.timeMs });
    assert.equal(fromBeacon.ok, true, fromBeacon.why);
    const flipped = Uint8Array.from(beacon.hash); flipped[0] ^= 1;
    const other = committeeSeedFromBeacon(w.c, { roundId: w.rid, randomness: flipped, height: beacon.height, timeMs: beacon.timeMs });
    const rosters = [w.a, w.b].map((d) => d.roster.seedFor(w.rid, w.c));
    const core = coreOf(w.c);
    const marks = marksAt(w.a, w, played.eid).map((m) => ({ tick: m.tick, stateHash: m.stateHash }));
    const under = (randomness) => replay(w.a.round.transcript(w.rid, played.eid), played.entry, { core, roundRandomness: randomness, marks });
    const onBeacon = under(beacon.hash);
    const onConstant = under(RANDOMNESS);
    const facts = { seed: toHex(fromBeacon.seed).slice(0, 16), rosters: rosters.map((r) => r.ok && toHex(r.seed).slice(0, 16)),
      flippedSeed: other.ok && toHex(other.seed).slice(0, 16), marks: marks.length,
      onBeacon: { agrees: onBeacon.agrees, checked: onBeacon.checked }, onConstant: { agrees: onConstant.agrees, divergedAt: onConstant.divergedAt },
      worldSeed: seedWordForEntry(played.entry, beacon.hash), constantWorldSeed: seedWordForEntry(played.entry, RANDOMNESS) };
    console.log('  FACTS (derive):', JSON.stringify(facts));
    assert.deepEqual(facts.rosters, [facts.seed, facts.seed], 'a holder draws the committee on another seed than the beacon\'s');
    assert.notEqual(facts.flippedSeed, facts.seed, 'the committee seed does not depend on the beacon');
    assert.ok(facts.marks >= 1, 'no mark was stored to check the world against');
    assert.deepEqual(facts.onBeacon, { agrees: true, checked: facts.marks }, 'the node\'s replay under the beacon does not reach the player\'s mark');
    assert.equal(facts.onConstant.agrees, false, 'the mark agrees under the fixtures\' constant too, so it measures nothing');
    assert.notEqual(facts.worldSeed, facts.constantWorldSeed);
  } finally { await w.close(); }
});

test('3. a round on a fixed beacon replays bit-identically: the same contract mines the same beacon, and every replay of every holder\'s transcript reaches one state', async () => {
  const w = await lockRound();
  try {
    const played = await lockAndPlay(w, LOSER);
    const beacon = w.slot.randomnessFor({ contract: w.c });
    // THE SAME CONTRACT ON A FRESH CHAIN, mined again from nothing: the beacon is fixed by the contract and its bonds.
    const again = bondedChainSlot();
    bondedChainFor(w.c.nodes, w.c, again, { endpoints: [w.a, w.b].map((d) => `ws://127.0.0.1:${d.port}`) });
    const remined = again.randomnessFor({ contract: w.c });
    const core = coreOf(w.c);
    const runs = [];
    for (const d of [w.a, w.b, w.a, w.b]) {
      const r = replay(d.round.transcript(w.rid, played.eid), played.entry, { core, roundRandomness: beacon.hash });
      assert.equal(r.ok, true, r.why);
      runs.push({ stateHash: r.stateHash, outcome: r.outcome, score: r.score, ticks: r.ticks });
    }
    // AND THE PLAYER'S OWN STEPPING, from the same seed word over the same inputs - its bed declared at tick 0 as the
    // fixture's batch declares it (lockAndPlay)
    const st = loaded(init(seedWordForEntry(played.entry, beacon.hash)));
    for (let t = 0; t < LOSER.ticks; t++) step(st, ...wordsAt(t));
    const facts = { beacon: toHex(beacon.hash).slice(0, 16), remined: toHex(remined.hash).slice(0, 16), height: [beacon.height, remined.height],
      runs: runs.map((r) => `${r.stateHash.slice(0, 16)} ${r.outcome} ${r.score} ${r.ticks}`), player: stateHash(st).slice(0, 16) };
    console.log('  FACTS (replay):', JSON.stringify(facts));
    assert.equal(facts.remined, facts.beacon, 'the same contract mined again names another beacon');
    assert.equal(beacon.height, remined.height);
    for (const r of runs) assert.deepEqual(r, runs[0], 'two replays of one round on one beacon differ');
    assert.equal(runs[0].stateHash, stateHash(st), 'the node\'s replay and the player\'s stepping reach different states');
  } finally { await w.close(); }
});
