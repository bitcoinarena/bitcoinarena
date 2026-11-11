// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A SIGNER NODE WHOSE PEER IS DOWN AT THE CLOSE HOLDS AND TRIES AGAIN (M3.3-34, the Daily's close).
//
// Signer node A closes a free 2-of-2 round while signer node B is down: A cannot pull B's
// receipts, so it can neither form the receipted transcript of a played run
// nor rule out a first mark B holds. It signs nothing - HOLDING at /closing,
// the close tried again on the finality watch's cadence - and records no
// ENTRY_VOID and no VOID: a disconnect is not an escape. When B is back and
// closes too, both signer nodes sign ONE transcript per run and it goes FINAL 2 of 2:
//   W  joined, sent nothing                FORFEIT, score 0
//   P  marks at ticks 60 and 120, stops    FAILED at its last receipted mark
// And it keeps asking past the objection window, and across a restart of A.
//
// MEASURED BEFORE (TASKBOOK, M3.3-34): the close ran once - a signer node that could
// not reach its peer signed neither run and nothing asked again; then, with
// the first retry build, the watch gave up at the window's end and a restart
// forgot the hold.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { resultFinality } from '../src/finality.js';
import { assumeAssigned } from './assignment.js';
import { rand, WINDOW_MS, WINNER, GENESIS_HASH, wordsAt, contractFor, say, opts, wait, RANDOMNESS, presentDay } from './window-fixture.js';
import { testNow, skipTo } from './test-clock.js';
import { roundEndMs } from '../../arena-protocol/src/first-mark.js';
import { encodeRoundContract, roundId, encodeEntryContract, entryId } from '../../arena-protocol/src/contracts.js';
import { encodeInputBatch, signedBatchOf, batchId } from '../../arena-protocol/src/batch.js';
import { encodeCheckpoint, checkpointId, joinSigned, NO_PREVIOUS } from '../../arena-protocol/src/checkpoint.js';
import { decodePlayerResult, splitSignedResult } from '../../arena-protocol/src/result.js';
import { init, step } from '../../nextblock/src/sim.js';
import { hash as stateHash } from '../../nextblock/src/state.js';
import { seedWordForEntry } from '../../arena-protocol/src/seed.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { HOSTED } from './plugins/hosted.js';
import { WebSocket } from 'ws';
import { SIGNED_RECEIPT_BYTES } from '../../arena-protocol/src/receipt.js';

async function signerNodes({ finality = {}, endIn = null } = {}) {
  const mk = (db, port = 0, more = {}) => serve(db, { plugins: HOSTED, port, ...opts, finality: { everyMs: 100, ...finality }, ...more });
  const dbA = openStore(':memory:');
  const dbB = openStore(':memory:');
  let a = await mk(dbA);
  let b = await mk(dbB);
  const aPort = a.port;
  const bPort = b.port;
  const wire = () => {
    for (const [d, o] of [[a, b], [b, a]]) {
      const there = [`http://127.0.0.1:${o.port}`];
      d.verifier.peers = there; d.stakeSecrets.peers = there; d.dkg.peers = there;
    }
  };
  wire();
  const base = { ...contractFor([a.round.pubkey, b.round.pubkey], BigInt(WINDOW_MS), [a, b].map((d) => `http://127.0.0.1:${d.port}`)),
    stakeMsat: 0n, federationId: new Uint8Array(32) };
  // `endIn`: THE ROUND IN THE PRESENT, its contract end this many ms from now (§13C's result window opens at it, and the
  // objection window: 600 s of wall time, WINDOW-10-SPEC). Left out, the round sits in 1970 and both windows closed long ago.
  const c = endIn === null ? base : presentDay(base, testNow() + endIn);
  const rid = roundId(c);
  for (const d of [a, b]) {
    assert.equal((await fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: encodeRoundContract(c) })).status, 201);
    assumeAssigned(d.round, rid, c.nodes);
  }
  return { get a() { return a; }, get b() { return b; }, c, rid,
    async downB() { await b.close(); }, async upB(more) { b = await mk(dbB, bPort, more); wire(); },
    async restartA(more) { await a.close(); a = await mk(dbA, aPort, more); wire(); },
    async close() { try { await a.close(); } catch { /* down */ } try { await b.close(); } catch { /* down */ } } };
}

async function signerNode(w, playerPubkey) {
  const session = ed25519.utils.randomSecretKey();
  const entry = { roundId: w.rid, playerPubkey, sessionPubkey: ed25519.getPublicKey(session),
    stakeCommitment: rand(32), stakeMsat: 0n, feeMsat: 0n, donationMsat: 0n, joinTick: 0, worldSecret: WINNER.worldSecret,
    vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32),
    stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n },
    claimKeyAttestationRef: new Uint8Array(32) };
  const eid = entryId(entry);
  for (const d of [w.a, w.b])
    assert.equal((await fetch(`http://127.0.0.1:${d.port}/entry`, { method: 'POST', body: encodeEntryContract(entry) })).status, 201);
  const st = init(seedWordForEntry(entry, RANDOMNESS));
  const hashNow = () => Uint8Array.from(stateHash(st).match(/../g).map((x) => parseInt(x, 16)));
  const sign = (m) => joinSigned(encodeCheckpoint(m), ed25519.sign(checkpointId(m), session));
  for (let t = 0; t < 60; t++) step(st, ...wordsAt(t));
  const b1 = { roundId: w.rid, entryId: eid, previousHash: GENESIS_HASH, firstTick: 0, ticks: Array.from({ length: 60 }, (_, t) => wordsAt(t)), liquidations: [] };
  const m1 = { roundId: w.rid, entryId: eid, tick: 60, stateHash: hashNow(), inputChainHash: batchId(b1), previousHash: NO_PREVIOUS, sessionPubkey: entry.sessionPubkey };
  // AND A SECOND MARK, at tick 120: a signer node that forwarded the first mark holds its
  // peer's receipt of that one only, so the two signer nodes' receipted transcripts
  // differ unless the one that could not reach its peer waits.
  for (let t = 60; t < 120; t++) step(st, ...wordsAt(t));
  const b2 = { roundId: w.rid, entryId: eid, previousHash: batchId(b1), firstTick: 60, ticks: Array.from({ length: 60 }, (_, t) => wordsAt(60 + t)), liquidations: [] };
  const m2 = { roundId: w.rid, entryId: eid, tick: 120, stateHash: hashNow(), inputChainHash: batchId(b2), previousHash: checkpointId(m1), sessionPubkey: entry.sessionPubkey };
  // input batches are signed by the entry's session key since #1503 (round 2), as close-retry's fixture sends them
  return { eid, start: [signedBatchOf(b1, (id) => ed25519.sign(id, session)), sign(m1)], more: [signedBatchOf(b2, (id) => ed25519.sign(id, session)), sign(m2)] };
}

const look = (w, d, run) => ({
  results: [...new Set(d.round.results(w.rid, run.eid).map((r) => { const p = decodePlayerResult(splitSignedResult(r.bytes).body); return `${p.outcome}/${p.score}`; }))],
  signers: new Set(d.round.results(w.rid, run.eid).map((r) => toHex(r.nodePubkey))).size,
  transcripts: new Set(d.round.results(w.rid, run.eid).map((r) => toHex(decodePlayerResult(splitSignedResult(r.bytes).body).transcriptHash))).size,
  finality: resultFinality(d.round, w.rid, run.eid).state, entryVoid: !!d.round.entryVoid(run.eid) });
const closingAt = async (w, d, run) => (await (await fetch(`http://127.0.0.1:${d.port}/closing?round=${toHex(w.rid)}`)).json())
  .find((s) => s.entry === toHex(run.eid)) || null;
const brief = (c) => c && { state: c.state, attempts: c.attempts, sinceMs: c.sinceMs, lastWhy: c.lastWhy && c.lastWhy.slice(0, 50) };
// WAITED ON, NOT SLEPT ON: in the full suite a close can take longer than a
// fixed sleep, and a count read too early reads nothing.
const until = async (ms, ok) => { for (let t = Date.now(); Date.now() - t < ms; await wait(100)) { const v = await ok(); if (v) return v; } return null; };

async function playedAndJoined(w) {
  const P = await signerNode(w, WINNER.key);
  const W = await signerNode(w, schnorr.getPublicKey(rand(32)));
  for (const d of [w.a, w.b]) for (const m of P.start) await say(d.port, m);
  await wait(300);
  for (const d of [w.a, w.b]) for (const m of P.more) await say(d.port, m);
  await wait(300);
  return { P, W };
}
async function backAndFinal(w, runs, more) {
  await w.upB(more);
  assert.equal(await say(w.b.port, `close ${toHex(w.rid)}`), 'closed');
  // BOTH SIGN, THEN THE WINDOW RUNS ITS 600 s (WINDOW-10-SPEC) - skipped on the fixtures' clock - AND BOTH SIGN FINAL.
  const states = () => [w.a, w.b].flatMap((d) => runs.map((r) => resultFinality(d.round, w.rid, r.eid).state));
  // AND PUBLISHED, as a live seat's are seconds after its result (§13A,: a posting counts only if its seat held it
  // before final_after) - then the skip
  const ready = () => [w.a, w.b].every((d) => runs.every((r) => { const f = resultFinality(d.round, w.rid, r.eid); return f.state === 'FINAL' || (f.state === 'PROVISIONALLY_FINAL' && f.published === true); }));
  for (let t = Date.now(); Date.now() - t < 25000; await wait(200))
    if (ready()) break;
  skipTo(Number(roundEndMs(w.c)) + 605000 + 100);
  for (let t = Date.now(); Date.now() - t < 25000; await wait(200))
    if (states().every((x) => x === 'FINAL')) break;
}
function assertOneFinal(after) {
  for (const s of ['a', 'b']) {
    assert.deepEqual(after.W[s], { results: ['FORFEIT/0'], signers: 2, transcripts: 1, finality: 'FINAL', entryVoid: false });
    assert.equal(after.P[s].results.length, 1);
    assert.match(after.P[s].results[0], /^FAILED\//);
    assert.deepEqual({ ...after.P[s], results: undefined }, { results: undefined, signers: 2, transcripts: 1, finality: 'FINAL', entryVoid: false });
  }
}


// kanban #1489 round 3 (play): ONE PUBLIC RECEIPT, SENT AGAIN AND AGAIN, IS A FULL REPLAY EACH TIME.
// The /play door takes a TYPE_CHECKPOINT_RECEIPT from anyone; a byte-identical receipt it already holds is answered
// 'held' without any check (the #1204 fast path), and then - the mark's round CLOSED - the door calls
// verifier.retry(round, entry) for EVERY such frame. retry queues a new whole-run replay (a new worker thread) into the
// replay pool for any run this seat has not signed yet (a run held at the close: a peer down, receipts short) - no
// dedupe, no bound, same class as the closes. A stranger copies one receipt from GET /receipts and sends it N times.
// Safe: repeats of a receipt the seat already holds start no new replay (at most one retry in flight per run).
test('#1489-r3-play-2: one held receipt replayed N times over /play queues N whole-run replays', async () => {
  const w = await signerNodes({ endIn: 5000 });
  try {
    const { P } = await playedAndJoined(w);
    await w.downB();
    assert.equal(await say(w.a.port, `close ${toHex(w.rid)}`), 'closed');
    await wait(1500);
    // the run is held at A: no result yet
    assert.equal(w.a.round.results(w.rid, P.eid).length, 0);
    // the stranger's copy of a public receipt
    const all = new Uint8Array(await (await fetch(`http://127.0.0.1:${w.a.port}/receipts?round=${toHex(w.rid)}&entry=${toHex(P.eid)}`)).arrayBuffer());
    assert.ok(all.length >= SIGNED_RECEIPT_BYTES);
    const one = all.slice(0, SIGNED_RECEIPT_BYTES);
    const pool = w.a.verifier.pool;
    let retries = 0;
    const submit = pool.submit.bind(pool);
    pool.submit = (job) => { if (String(job.key).endsWith(':retry')) retries++; return submit(job); };
    const N = 40;
    const answers = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${w.a.port}/play`);
      const got = [];
      ws.on('open', () => { for (let i = 0; i < N; i++) ws.send(one); });
      ws.on('message', (d) => { got.push(d.toString()); if (got.length === N) { ws.close(); resolve(got); } });
      ws.on('error', reject);
    });
    await wait(300);
    console.log(`  FACTS: ${N} copies of one held receipt answered ${JSON.stringify([...new Set(answers)])}; whole-run replays queued by retry: ${retries}; pool waiting ${pool.waiting}`);
    assert.ok(retries <= 1, `${retries} whole-run replays queued for ${N} copies of one receipt the seat already held`);
  } finally { await w.close(); }
});
