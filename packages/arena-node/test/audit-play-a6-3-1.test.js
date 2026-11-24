// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { resultFinality } from '../src/finality.js';
import { assumeAssigned } from './assignment.js';
import { rand, WINDOW_MS, WINNER, GENESIS_HASH, wordsAt, contractFor, say, opts, wait, RANDOMNESS, presentDay, loaded, bedFrom, qualifiersUnder } from './window-fixture.js';
import { testNow, skipTo } from './test-clock.js';
import { roundEndMs } from '../../arena-protocol/src/first-mark.js';
import { encodeRoundContract, roundId, encodeEntryContract, entryId } from '../../arena-protocol/src/contracts.js';
import { signedBatchOf, batchId } from '../../arena-protocol/src/batch.js';
import { encodeCheckpoint, checkpointId, joinSigned, NO_PREVIOUS } from '../../arena-protocol/src/checkpoint.js';
import { decodePlayerResult, splitSignedResult } from '../../arena-protocol/src/result.js';
import { init, step } from '../../nextblock/src/sim.js';
import { hash as stateHash } from '../../nextblock/src/state.js';
import { seedWordForEntry } from '../../arena-protocol/src/seed.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { HOSTED } from './plugins/hosted.js';

async function seats() {
  const mk = (db) => serve(db, { plugins: HOSTED, port: 0, ...opts, finality: { everyMs: 100 } });
  const a = await mk(openStore(':memory:'));
  const b = await mk(openStore(':memory:'));
  for (const [d, o] of [[a, b], [b, a]]) {
    const there = [`http://127.0.0.1:${o.port}`];
    d.verifier.peers = there; d.stakeSecrets.peers = there; d.dkg.peers = there;
  }
  const base = { ...contractFor([a.round.pubkey, b.round.pubkey], BigInt(WINDOW_MS), [a, b].map((d) => `http://127.0.0.1:${d.port}`)),
    stakeMsat: 0n, federationId: new Uint8Array(32) };
  const c = presentDay(base, testNow() + 5000);
  const rid = roundId(c);
  for (const d of [a, b]) {
    assert.equal((await fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: encodeRoundContract(c) })).status, 201);
    assumeAssigned(d.round, rid, c.nodes);
  }
  return { a, b, c, rid, async close() { try { await a.close(); } catch { /* down */ } try { await b.close(); } catch { /* down */ } } };
}

async function player(w, q) {
  const session = ed25519.utils.randomSecretKey();
  const entry = { roundId: w.rid, playerPubkey: q.key, sessionPubkey: ed25519.getPublicKey(session),
    stakeCommitment: rand(32), stakeMsat: 0n, feeMsat: 0n, donationMsat: 0n, joinTick: 0, worldSecret: q.worldSecret,
    vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32),
    stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n },
    claimKeyAttestationRef: new Uint8Array(32) };
  const eid = entryId(entry);
  for (const d of [w.a, w.b])
    assert.equal((await fetch(`http://127.0.0.1:${d.port}/entry`, { method: 'POST', body: encodeEntryContract(entry) })).status, 201);
  const st = loaded(init(seedWordForEntry(entry, RANDOMNESS)));
  const hashNow = () => Uint8Array.from(stateHash(st).match(/../g).map((x) => parseInt(x, 16)));
  const sign = (m) => joinSigned(encodeCheckpoint(m), ed25519.sign(checkpointId(m), session));
  for (let t = 0; t < 60; t++) step(st, ...q.words(t));
  const b1 = { roundId: w.rid, entryId: eid, previousHash: GENESIS_HASH, firstTick: 0, ticks: Array.from({ length: 60 }, (_, t) => q.words(t)), liquidations: [], loads: bedFrom(0) };
  const m1 = { roundId: w.rid, entryId: eid, tick: 60, stateHash: hashNow(), inputChainHash: batchId(b1), previousHash: NO_PREVIOUS };
  for (let t = 60; t < 120; t++) step(st, ...q.words(t));
  const b2 = { roundId: w.rid, entryId: eid, previousHash: batchId(b1), firstTick: 60, ticks: Array.from({ length: 60 }, (_, t) => q.words(60 + t)), liquidations: [] };
  const m2 = { roundId: w.rid, entryId: eid, tick: 120, stateHash: hashNow(), inputChainHash: batchId(b2), previousHash: checkpointId(m1) };
  const sb = (b) => signedBatchOf(b, (id) => ed25519.sign(id, session));
  return { eid, b1: sb(b1), m1: sign(m1), b2: sb(b2), m2: sign(m2), b2id: batchId(b2), sb };
}

const look = (w, d, eid) => ({
  results: [...new Set(d.round.results(w.rid, eid).map((r) => { const p = decodePlayerResult(splitSignedResult(r.bytes).body); return `${p.outcome}/${p.score}`; }))],
  signers: new Set(d.round.results(w.rid, eid).map((r) => toHex(r.nodePubkey))).size,
  finality: resultFinality(d.round, w.rid, eid).state });


// AUDIT play-a6-3-1 (role a, a modified player client). verify.js close: a run whose replay of ALL the ticks this seat
// stored ends (DELIVERED or FAILED) is signed with that outcome and score over the canonical transcript, even when the
// ticks that ended it lie past the last carried mark and were never carried (#atLastMark cuts the uncarried tail only
// when the replay is still LIVE). The player decides which seats hold such a tail: batches need no mark and no other
// seat. Seats holding one canonical transcript then sign different results - no threshold, VOID (§13C).
// SAFE: two seats that carried the same marks sign the same result, whatever uncarried ticks one of them holds.
test('#play-a6-3-1: uncarried tail ticks sent to one seat only do not change what that seat signs', async () => {
  const w = await seats();
  try {
    const Q = (await qualifiersUnder(RANDOMNESS, 1))[0];
    console.log('  player drives', Q.name, 'DELIVERED under the round beacon');
    const P = await player(w, Q);
    for (const d of [w.a, w.b]) { await say(d.port, P.b1); await say(d.port, P.m1); }
    await wait(300);
    for (const d of [w.a, w.b]) { await say(d.port, P.b2); await say(d.port, P.m2); }
    await wait(300);
    // THE ATTACK: the rest of the drive (ticks 120..1319, the truck arrives before 1320) goes to seat A only, as batches, with no mark
    const tail = { roundId: w.rid, entryId: P.eid, previousHash: P.b2id, firstTick: 120, ticks: Array.from({ length: 1200 }, (_, t) => Q.words(120 + t)), liquidations: [] };
    const took = await say(w.a.port, P.sb(tail));
    console.log('  tail batch at A answered', String(took).slice(0, 80));
    await wait(300);
    for (const d of [w.a, w.b]) assert.equal(await say(d.port, `close ${toHex(w.rid)}`), 'closed');
    const signed = () => [w.a, w.b].every((d) => d.round.results(w.rid, P.eid).some((r) => toHex(r.nodePubkey) === toHex(d.round.pubkey)));
    for (let t = Date.now(); Date.now() - t < 30000; await wait(200)) if (signed()) break;
    const own = (d) => { const r = d.round.results(w.rid, P.eid).find((x) => toHex(x.nodePubkey) === toHex(d.round.pubkey));
      if (!r) return null; const p = decodePlayerResult(splitSignedResult(r.bytes).body); return { outcome: p.outcome, score: p.score, transcript: toHex(p.transcriptHash).slice(0, 16) }; };
    const after = { a: own(w.a), b: own(w.b), canonicalA: toHex(w.a.round.canonicalTranscript(w.rid, P.eid).hash).slice(0, 16),
      canonicalB: toHex(w.b.round.canonicalTranscript(w.rid, P.eid).hash).slice(0, 16), ticksA: w.a.round.heldInputTicks(w.rid, P.eid), ticksB: w.b.round.heldInputTicks(w.rid, P.eid) };
    console.log('  FACTS play-a6-3-1:', JSON.stringify(after));
    assert.ok(after.a && after.b, `both seats sign: ${JSON.stringify(after)}`);
    assert.equal(after.canonicalA, after.canonicalB, 'precondition: both seats carried the same marks');
    assert.deepEqual(after.a, after.b, `one canonical transcript, two signed results: A ${after.a.outcome}/${after.a.score}, B ${after.b.outcome}/${after.b.score}`);
  } finally { await w.close(); }
});
