// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 audit r6 (play) 11: ONE SEAT RE-SIGNS ITS OWN RECEIPT AND EVERY FRAME IS A WHOLE-RUN REPLAY (bypass of #1569 / r3-play-2).
// #1569 stopped a byte-identical receipt from starting a replay: the /play door asks round.holdsReceipt(bytes) - byte for
// byte - and only "a receipt this seat did not hold before" calls verifier.retry. But BIP-340 signatures are randomised:
// a committee seat signs the SAME receipt body (its own receipt of a mark the honest seat holds) again with fresh aux
// randomness and gets new bytes every time. holdsReceipt says "not held", takeReceipt answers 'held' (same body: a
// harmless repeat, nothing stored) - and the door still calls verifier.retry, a whole-run replay in the pool, for every
// such frame. retry's in-flight dedupe only bounds concurrency (two at a time); frames spaced by a replay's length are
// each a new replay, without end, for any run this seat has not signed yet (held at the close: a peer down, receipts
// short). ONE seat (role b) keeps every honest seat's replay pool busy on that run.
// Safe: a receipt that adds nothing (its body already held from that signer) starts no replay.
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
import { decodeCheckpointReceipt, splitSignedReceipt, encodeCheckpointReceipt, joinSignedReceipt, receiptId } from '../../arena-protocol/src/receipt.js';

test('#1489-r6-play-11: a committee seat re-signing its own receipt makes the honest seat replay the run on every frame', { timeout: 120000 }, async () => {
  const w = await signerNodes({ endIn: 5000 });
  try {
    const { P } = await playedAndJoined(w);
    const bKey = w.b.round.pubkey; const bSecret = w.b.round.identity.secret;
    await w.downB();
    assert.equal(await say(w.a.port, `close ${toHex(w.rid)}`), 'closed');
    await wait(1500);
    assert.equal(w.a.round.results(w.rid, P.eid).length, 0, 'the run is held at A');
    // B's own receipt of P's first mark, as A holds it (it came back on the forward)
    const all = new Uint8Array(await (await fetch(`http://127.0.0.1:${w.a.port}/receipts?round=${toHex(w.rid)}&entry=${toHex(P.eid)}`)).arrayBuffer());
    let body = null;
    for (let at = 0; at + SIGNED_RECEIPT_BYTES <= all.length; at += SIGNED_RECEIPT_BYTES) {
      const one = all.slice(at, at + SIGNED_RECEIPT_BYTES);
      const s = splitSignedReceipt(one);
      if (toHex(decodeCheckpointReceipt(s.body).nodePubkey) === toHex(bKey)) { body = s.body; break; }
    }
    assert.ok(body, 'A holds a receipt of B');
    const r = decodeCheckpointReceipt(body);
    const resigned = () => joinSignedReceipt(encodeCheckpointReceipt(r), schnorr.sign(receiptId(r), bSecret));
    const pool = w.a.verifier.pool;
    let retries = 0;
    const submit = pool.submit.bind(pool);
    pool.submit = (job) => { if (String(job.key).endsWith(':retry')) retries++; return submit(job); };
    const N = 20;
    const ws = new WebSocket(`ws://127.0.0.1:${w.a.port}/play`);
    await new Promise((ok, no) => { ws.on('open', ok); ws.on('error', no); });
    const answers = [];
    for (let i = 0; i < N; i++) {
      const x = resigned();
      // (new bytes each time - BIP-340 aux randomness; kanban #2742 makes the door treat its body as held, so this is no longer asserted)
      answers.push(await new Promise((ok) => { ws.once('message', (d) => ok(d.toString())); ws.send(x); }));
      await until(3000, () => !w.a.verifier.retrying.size);
      await wait(50);
    }
    ws.close();
    console.log(`  FACTS: ${N} re-signed copies of B's one receipt answered ${JSON.stringify([...new Set(answers)])}; whole-run replays queued by retry at A: ${retries}; A's results for the run: ${w.a.round.results(w.rid, P.eid).length}`);
    assert.ok(retries <= 1, `${retries} whole-run replays for ${N} re-signed copies of one receipt body A already held from B`);
  } finally { await w.close(); }
});
