// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// TWO TITLES AND TWO RULE SETS ON THE SAME SIGNER NODES, IN THE SAME WINDOW (M3 R1 step C; the owner
// 2026-09-15 08:07: "several games at once, and several rule sets at once. Each round names its
// core and its rules; signer nodes replay what that round names. Two titles and two configs can run on the
// same nodes in the same window").
//
// Two signer nodes run the truck and a second title beside it - the counter (test/cores/counter.js: a run
// adds its first input word each tick and delivers when the sum reaches its config's target). Three
// free rounds open on them at once: the truck's, and the counter's under two configs, a low bar and
// a high one. Each is played with the same words, 120 ticks, marks at 60 and 120 whose state hashes
// the round's own core computes under the round's own config. Each is replayed by that core under
// that config: the counter's same run DELIVERS under one config and FAILS under the other, every
// result names the core that replayed it, and all three go final 2 of 2. A signer node that did not
// install the counter refuses its round at the door.
import { testNow, skipTo } from './test-clock.js';
import { presentDay } from './window-fixture.js';
import { windowsOf } from '../../arena-protocol/src/window.js';
import { test } from 'node:test';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { resultFinality } from '../src/finality.js';
import { TRUCK, TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH } from '../../nextblock/plugin/nextblock.js';
import { COUNTER, CONFIGS, COUNTER_GAME, COUNTER_GAME_ID } from './cores/counter.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { assumeAssigned } from './assignment.js';
import { rand, WINDOW_MS, WINNER, GENESIS_HASH, wordsAt, contractFor, say, opts, wait, RANDOMNESS } from './window-fixture.js';
import { encodeRoundContract, roundId, encodeEntryContract, entryId } from '../../arena-protocol/src/contracts.js';
import { encodeInputBatch, batchId } from '../../arena-protocol/src/batch.js';
import { encodeCheckpoint, checkpointId, joinSigned, NO_PREVIOUS } from '../../arena-protocol/src/checkpoint.js';
import { decodePlayerResult, splitSignedResult } from '../../arena-protocol/src/result.js';
import { seedWordForEntry } from '../../arena-protocol/src/seed.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { HOSTED } from './plugins/hosted.js';

const COUNTER_CORE_HASH = fromHex(COUNTER.hash);
const [LOW, HIGH] = CONFIGS;

async function twoSignerNodes() {
  const mk = () => serve(openStore(':memory:'), { plugins: [NEXTBLOCK, COUNTER_GAME], port: 0, ...opts, finality: { everyMs: 100 } });
  const a = await mk();
  const b = await mk();
  for (const [d, o] of [[a, b], [b, a]]) {
    const there = [`http://127.0.0.1:${o.port}`];
    d.verifier.peers = there; d.stakeSecrets.peers = there; d.dkg.peers = there;
  }
  return { a, b, async close() { await a.close(); await b.close(); } };
}

/** A free round on both signer nodes, naming the core and config given. */
// A round shorter than the fixture's start deadline names its own (the protocol: the deadline is below the run length).
// THE RUN LENGTH COMES FROM THE CORE, NOT A LITERAL. This defaulted to 9000, the
// number before WAR_TACTICS moved a run to 10800, and the node refuses a contract
// that disagrees with the core it names - "a contract disagreeing with the network
// it names". The rest of this family was migrated when the core moved; this one
// was missed, and the refusal was correct the whole time.
async function open(w, simCoreHash, configHash, blockTicks = BLOCK_TICKS, startDeadlineTicks) {
  // THE ROUND ENDS NOW, NOT IN 1970 (a result counts only if its seat held it before the round's end + 605 s)
  const c = presentDay({ ...contractFor([w.a.round.pubkey, w.b.round.pubkey], BigInt(WINDOW_MS), [w.a, w.b].map((d) => `http://127.0.0.1:${d.port}`)),
    // THE ROUND'S GAME: the counter is a game of its own, nextblock plays the truck
    gameId: toHex(simCoreHash) === COUNTER.hash ? COUNTER_GAME_ID : NEXTBLOCK.gameId,
    stakeMsat: 0n, federationId: new Uint8Array(32), simCoreHash, configHash, blockTicks, ...(startDeadlineTicks ? { startDeadlineTicks } : {}) }, testNow() + 3000);
  const rid = roundId(c);
  for (const d of [w.a, w.b]) {
    const r = await fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: encodeRoundContract(c) });
    assert.equal(r.status, 201, await r.text());
    assumeAssigned(d.round, rid, c.nodes);
  }
  return { c, rid };
}

/** One player on a round: joined at both signer nodes, 120 ticks played by the round's own core, marks at 60 and 120. */
async function play(w, rid, adapter, config) {
  const session = ed25519.utils.randomSecretKey();
  const entry = { roundId: rid, playerPubkey: WINNER.key, sessionPubkey: ed25519.getPublicKey(session),
    stakeCommitment: rand(32), stakeMsat: 0n, feeMsat: 0n, donationMsat: 0n, joinTick: 0, worldSecret: WINNER.worldSecret,
    vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32),
    stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n },
    claimKeyAttestationRef: new Uint8Array(32) };
  const eid = entryId(entry);
  for (const d of [w.a, w.b])
    assert.equal((await fetch(`http://127.0.0.1:${d.port}/entry`, { method: 'POST', body: encodeEntryContract(entry) })).status, 201);
  const st = adapter.start(seedWordForEntry(entry, RANDOMNESS), config);
  const hashNow = () => fromHex(adapter.stateHash(st));
  const sign = (m) => joinSigned(encodeCheckpoint(m), ed25519.sign(checkpointId(m), session));
  const words = (from) => Array.from({ length: 60 }, (_, t) => wordsAt(from + t));
  for (let t = 0; t < 60; t++) adapter.step(st, wordsAt(t));
  const b1 = { roundId: rid, entryId: eid, previousHash: GENESIS_HASH, firstTick: 0, ticks: words(0), liquidations: [] };
  const m1 = { roundId: rid, entryId: eid, tick: 60, stateHash: hashNow(), inputChainHash: batchId(b1), previousHash: NO_PREVIOUS, sessionPubkey: entry.sessionPubkey };
  for (let t = 60; t < 120; t++) adapter.step(st, wordsAt(t));
  const b2 = { roundId: rid, entryId: eid, previousHash: batchId(b1), firstTick: 60, ticks: words(60), liquidations: [] };
  const m2 = { roundId: rid, entryId: eid, tick: 120, stateHash: hashNow(), inputChainHash: batchId(b2), previousHash: checkpointId(m1), sessionPubkey: entry.sessionPubkey };
  for (const d of [w.a, w.b]) for (const m of [encodeInputBatch(b1), sign(m1)]) await say(d.port, m);
  await wait(300);
  for (const d of [w.a, w.b]) for (const m of [encodeInputBatch(b2), sign(m2)]) await say(d.port, m);
  await wait(300);
  return { eid, played: adapter.result(st) };
}

const signedAt = (d, rid, eid) => d.round.results(rid, eid).map((r) => {
  const p = decodePlayerResult(splitSignedResult(r.bytes).body);
  return { outcome: p.outcome, score: p.score, core: toHex(p.simCoreHash) };
});

test('the truck and a second title, the second under two configs, run on the same two signer nodes in one window - each replayed by its own core under its own config, each result naming it', async () => {
  const w = await twoSignerNodes();
  try {
    const truck = await open(w, TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH);
    const low = await open(w, COUNTER_CORE_HASH, LOW.hash, LOW.config.ticks, 90);
    const high = await open(w, COUNTER_CORE_HASH, HIGH.hash, HIGH.config.ticks, 90);
    const runs = {
      truck: { ...truck, ...(await play(w, truck.rid, TRUCK.adapter, {})) },
      low: { ...low, ...(await play(w, low.rid, COUNTER.adapter, LOW.config)) },
      high: { ...high, ...(await play(w, high.rid, COUNTER.adapter, HIGH.config)) },
    };
    for (const r of Object.values(runs)) for (const d of [w.a, w.b]) assert.equal(await say(d.port, `close ${toHex(r.rid)}`), 'closed');
    // agreed and published at both inside the window, then past final_after, as a live round goes
    const ready = () => Object.values(runs).every((r) => [w.a, w.b].every((d) => { const f = resultFinality(d.round, r.rid, r.eid); return f.state === 'PROVISIONALLY_FINAL' && f.published === true; }));
    for (let t = Date.now(); Date.now() - t < 25000 && !ready(); await wait(200));
    skipTo(Math.max(...Object.values(runs).map((r) => Number(windowsOf(r.c).finalAfterMs))) + 50);
    const final = () => Object.values(runs).every((r) => [w.a, w.b].every((d) => resultFinality(d.round, r.rid, r.eid).state === 'FINAL'));
    for (let t = Date.now(); Date.now() - t < 25000 && !final(); await wait(200));
    const facts = Object.fromEntries(Object.entries(runs).map(([k, r]) => [k, {
      played: r.played, a: signedAt(w.a, r.rid, r.eid), b: signedAt(w.b, r.rid, r.eid),
      finality: [w.a, w.b].map((d) => resultFinality(d.round, r.rid, r.eid).state),
    }]));
    console.log('  FACTS (two titles):', JSON.stringify(facts));

    for (const k of ['truck', 'low', 'high']) {
      assert.deepEqual(facts[k].finality, ['FINAL', 'FINAL'], `${k} did not go final 2 of 2`);
      // EACH SIGNER NODE HOLDS BOTH SIGNER NODES' SIGNED RESULTS - its own and its peer's, gathered: the 2 of 2 that
      // made the run FINAL - and the two say the same thing, under the same core. (First written
      // as "one result at A": measured, each signer node holds two.)
      for (const s of ['a', 'b']) {
        assert.equal(facts[k][s].length, 2, `${k}: signer node ${s} holds ${facts[k][s].length} signed results, not the two signer nodes'`);
        assert.equal(new Set(facts[k][s].map((r) => `${r.core}/${r.outcome}/${r.score}`)).size, 1,
          `${k}: the two signer nodes signed different results`);
      }
    }
    assert.equal(facts.truck.a[0].core, TRUCK.hash, 'the truck round\'s result names another core');
    for (const k of ['low', 'high']) {
      for (const s of ['a', 'b']) assert.equal(facts[k][s][0].core, COUNTER.hash, `${k} at ${s} names another core than the counter`);
      // THE SUM IS THE DRIVER'S, NOT A NUMBER WRITTEN HERE. The counter core adds
      // `w[0]` for each of its 120 ticks, so its score is 120 throttles. This read
      // `120 * 45875` - seven tenths throttle, the fixed program the fixture drove
      // before 2026-09-21, when it started steering at the gate the core publishes
      // and went to full throttle. The core did not change; the driver did, and this
      // one expectation was left behind. Taken from `wordsAt` now, so the day the
      // driver moves again this follows it instead of going red.
      assert.equal(facts[k].a[0].score, 120 * wordsAt(0)[0], `${k}: the counter's sum`);
    }
    assert.equal(facts.low.a[0].outcome, 'DELIVERED', 'the low bar was not met by the same run');
    assert.equal(facts.high.a[0].outcome, 'FAILED', 'the high bar was met by the same run');
  } finally { await w.close(); }
});

test('a signer node that does not host the second title refuses its round at the door, and still opens the truck\'s', async () => {
  const d = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, ...opts });
  try {
    const nodes = [d.round.pubkey, rand(32)];
    const base = { ...contractFor(nodes, BigInt(WINDOW_MS)), stakeMsat: 0n, federationId: new Uint8Array(32) };
    const post = async (c) => { const r = await fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: encodeRoundContract(c) }); return { status: r.status, why: (await r.text()).trim() }; };
    const counter = await post({ ...base, gameId: COUNTER_GAME_ID, simCoreHash: COUNTER_CORE_HASH, configHash: LOW.hash });
    const truck = await post({ ...base, gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH, configHash: TRUCK_V3_CONFIG_HASH });
    console.log('  FACTS (not installed):', JSON.stringify({ counter: { ...counter, why: counter.why.slice(0, 100) }, truck: truck.status }));
    assert.equal(counter.status, 409);
    // SINCE THE COUNTER IS A GAME the round is refused as a game this node does not host
    assert.match(counter.why, /this node does not host game/);
    assert.equal(truck.status, 201, truck.why);
  } finally { await d.close(); }
});
