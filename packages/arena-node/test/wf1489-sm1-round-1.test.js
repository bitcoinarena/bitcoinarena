// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 (state machine audit, round, sm1-round-1 on e2cd512d8): THE TWO ENDS OF A HELD FINAL MARK (#3212 / #3213) DO NOT MEET.
// A DELIVERED run's last mark reaches seat A only; seat B holds every input. A holds its close for the mark (pendingFinal) and, past
// 2 x HELD_FINAL_ASK_MS from its first sight, signs the STOPPED transcript (FAILED at the last carried mark, INSERT OR IGNORE: for good).
// B closes later - its close queue behind a round end's other replays, or catching up after a restart - and #holdBack takes A's mark
// (#3213: inputs whole, replay DELIVERED), its receipt carried, and signs DELIVERED. Nothing in either path asks what the other seat
// already signed: A FAILED, B DELIVERED, never 2 of 2 - the winner's run goes to §13C no quorum (VOID) instead of being paid.
// SAFE: whatever the order of the two closes, both seats sign one result.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { testNow, skipTo } from './test-clock.js';
import { presentDay, rand, WINDOW_MS, WINNER, GENESIS_HASH, wordsAt, contractFor, say, opts, wait, RANDOMNESS } from './window-fixture.js';
import { windowsOf } from '../../arena-protocol/src/window.js';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { resultFinality } from '../src/finality.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { COUNTER, CONFIGS, COUNTER_GAME, COUNTER_GAME_ID } from './cores/counter.js';
import { assumeAssigned } from './assignment.js';
import { encodeRoundContract, roundId, encodeEntryContract, entryId } from '../../arena-protocol/src/contracts.js';
import { signedBatchOf, batchId } from '../../arena-protocol/src/batch.js';
import { encodeCheckpoint, checkpointId, joinSigned, NO_PREVIOUS } from '../../arena-protocol/src/checkpoint.js';
import { decodePlayerResult, splitSignedResult } from '../../arena-protocol/src/result.js';
import { seedWordForEntry } from '../../arena-protocol/src/seed.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const [LOW] = CONFIGS;

async function setup() {
  const mk = () => serve(openStore(':memory:'), { plugins: [NEXTBLOCK, COUNTER_GAME], port: 0, ...opts, finality: { everyMs: 100 } });
  const a = await mk(); const b = await mk();
  for (const [d, o] of [[a, b], [b, a]]) { const there = [`http://127.0.0.1:${o.port}`]; d.verifier.peers = there; d.stakeSecrets.peers = there; d.dkg.peers = there; }
  const c = presentDay({ ...contractFor([a.round.pubkey, b.round.pubkey], BigInt(WINDOW_MS), [a, b].map((d) => `http://127.0.0.1:${d.port}`)),
    gameId: COUNTER_GAME_ID, stakeMsat: 0n, federationId: new Uint8Array(32), simCoreHash: fromHex(COUNTER.hash), configHash: LOW.hash,
    blockTicks: LOW.config.ticks, startDeadlineTicks: 90 }, testNow() + 3000);
  const rid = roundId(c);
  for (const d of [a, b]) {
    const r = await fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: encodeRoundContract(c) });
    assert.equal(r.status, 201, await r.text());
    assumeAssigned(d.round, rid, c.nodes);
  }
  const session = ed25519.utils.randomSecretKey();
  const entry = { roundId: rid, playerPubkey: WINNER.key, sessionPubkey: ed25519.getPublicKey(session),
    stakeCommitment: rand(32), stakeMsat: 0n, feeMsat: 0n, donationMsat: 0n, joinTick: 0, worldSecret: WINNER.worldSecret,
    vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32),
    stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n },
    claimKeyAttestationRef: new Uint8Array(32) };
  const eid = entryId(entry);
  for (const d of [a, b]) assert.equal((await fetch(`http://127.0.0.1:${d.port}/entry`, { method: 'POST', body: encodeEntryContract(entry) })).status, 201);
  const ad = COUNTER.adapter;
  const st = ad.start(seedWordForEntry(entry, RANDOMNESS), LOW.config);
  const hashNow = () => fromHex(ad.stateHash(st));
  const sign = (m) => joinSigned(encodeCheckpoint(m), ed25519.sign(checkpointId(m), session));
  const words = (from) => Array.from({ length: 60 }, (_, t) => wordsAt(from + t));
  for (let t = 0; t < 60; t++) ad.step(st, wordsAt(t));
  const b1 = { roundId: rid, entryId: eid, previousHash: GENESIS_HASH, firstTick: 0, ticks: words(0), liquidations: [] };
  const m1 = { roundId: rid, entryId: eid, tick: 60, stateHash: hashNow(), inputChainHash: batchId(b1), previousHash: NO_PREVIOUS, sessionPubkey: entry.sessionPubkey };
  for (let t = 60; t < 120; t++) ad.step(st, wordsAt(t));
  const b2 = { roundId: rid, entryId: eid, previousHash: batchId(b1), firstTick: 60, ticks: words(60), liquidations: [] };
  const m2 = { roundId: rid, entryId: eid, tick: 120, stateHash: hashNow(), inputChainHash: batchId(b2), previousHash: checkpointId(m1), sessionPubkey: entry.sessionPubkey };
  const sb = (x) => signedBatchOf(x, (id) => ed25519.sign(id, session));
  return { a, b, c, rid, eid, played: ad.result(st), B1: sb(b1), M1: sign(m1), B2: sb(b2), M2: sign(m2),
    async close() { try { await a.close(); } catch { /* down */ } try { await b.close(); } catch { /* down */ } } };
}

const look = (w, d) => ({
  results: [...new Set(d.round.results(w.rid, w.eid).map((r) => { const p = decodePlayerResult(splitSignedResult(r.bytes).body); return `${p.outcome}/${p.score}`; }))],
  signers: new Set(d.round.results(w.rid, w.eid).map((r) => toHex(r.nodePubkey))).size,
  finality: resultFinality(d.round, w.rid, w.eid).state });


test('#1489-sm1-round-1 a seat that closes after the mark holder gave its hold up signs the holder\'s stopped result, not DELIVERED', { timeout: 110000 }, async () => {
  const w = await setup();
  try {
    for (const d of [w.a, w.b]) { await say(d.port, w.B1); await say(d.port, w.M1); }
    await wait(300);
    for (const d of [w.a, w.b]) await say(d.port, w.B2);
    await say(w.a.port, w.M2);                         // the last mark reaches A only; B holds every input
    await wait(300);
    assert.equal(await say(w.a.port, `close ${toHex(w.rid)}`), 'closed');   // A closes first
    for (let t = Date.now(); Date.now() - t < 5000 && !(w.a.verifier.pendingSeen && w.a.verifier.pendingSeen.size); await wait(100));
    assert.ok(w.a.verifier.pendingSeen && w.a.verifier.pendingSeen.size, 'seat A never held its close for the final mark');
    skipTo(testNow() + 11000);                          // past 2 x HELD_FINAL_ASK_MS on the round clock: A gives its hold up
    for (let t = Date.now(); Date.now() - t < 15000 && !look(w, w.a).signers; await wait(100));
    const aFirst = look(w, w.a);
    assert.ok(aFirst.results.length, `seat A did not sign after its bound: ${JSON.stringify(aFirst)}`);
    assert.equal(await say(w.b.port, `close ${toHex(w.rid)}`), 'closed');   // B's close comes later
    const ready = () => [w.a, w.b].every((d) => { const f = resultFinality(d.round, w.rid, w.eid); return f.state === 'PROVISIONALLY_FINAL' && f.published === true; });
    for (let t = Date.now(); Date.now() - t < 25000 && !(ready() || (look(w, w.b).results.length && look(w, w.a).results.length > 0 && look(w, w.b).signers)); await wait(200));
    await wait(2000);
    const own = (d) => d.round.results(w.rid, w.eid).filter((r) => toHex(r.nodePubkey) === toHex(d.round.pubkey))
      .map((r) => { const p = decodePlayerResult(splitSignedResult(r.bytes).body); return `${p.outcome}/${p.score}`; });
    const facts = { played: w.played, a: own(w.a), b: own(w.b), aLook: look(w, w.a), bLook: look(w, w.b) };
    console.log('  FACTS (#1489-sm1-round-1):', JSON.stringify(facts));
    assert.ok(facts.a.length === 1 && facts.b.length === 1, `each seat signs once: ${JSON.stringify(facts)}`);
    assert.deepEqual(facts.b, facts.a, `the two seats signed different results for one run: ${JSON.stringify(facts)}`);
  } finally { await w.close(); }
});
