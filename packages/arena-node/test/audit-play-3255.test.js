// kanban #3255: the card's test (audit r20 play-1)
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// (fixture copied from wf1489-r6-play-11-2742)
// kanban #1489 audit r20 (play) 1: ONE SEAT RE-SIGNS ITS OWN RECEIPT AND EVERY FRAME IS A WHOLE-RUN REPLAY (bypass of #1569 / r3-play-2).
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

const until = async (ms, ok) => { for (let t = Date.now(); Date.now() - t < ms; await wait(100)) { const v = await ok(); if (v) return v; } return null; };
async function playedAndJoined(w) {
  const P = await signerNode(w, WINNER.key);
  for (const d of [w.a, w.b]) for (const m of P.start) await say(d.port, m);
  await wait(300);
  for (const d of [w.a, w.b]) for (const m of P.more) await say(d.port, m);
  await wait(300);
  return { P };
}

// THE HELD-BACK FINAL MARK, REPLAYED BY A STRANGER AFTER THE CLOSE, OPENS A WEBSOCKET TO EVERY PEER PER FRAME.
// The /play door: a TYPE_CHECKPOINT frame whose round is CLOSED and whose answer is a receipt calls offerReceipt, which
// opens a new WebSocket to every peer of the round and sends this seat's receipt - with no record that the receipt was
// offered already. After the close round.checkpoint takes exactly the held final mark, and a mark already stored answers
// its receipt again (receiptFor) - so while the hold stands, the held mark's bytes (public: GET /checkpoints) replayed N
// times by anyone make this seat open N x peers outbound connections (6 per frame on a 7-seat committee).
// Safe: a repeat of a mark already held (byte for byte, its receipt already offered) offers nothing again.
test('#1489-r20-play-1: replaying the held final mark after the close fans out one WebSocket per peer per frame', { timeout: 120000 }, async () => {
  const w = await signerNodes({});
  try {
    const { P } = await playedAndJoined(w);
    const m2 = P.more[1];
    assert.equal(await say(w.a.port, `close ${toHex(w.rid)}`), 'closed');
    await wait(1500);
    // THE HOLD: A keeps the run's final mark as its held-back ask (what #holdBack writes when a peer named a mark A had not got;
    // it stands until A's next close pass finds mark and inputs whole). Here the mark is already in A's store.
    w.a.round.putHeldFinalAsk({ roundId: w.rid, entryId: P.eid, mark: m2, tick: 120 });
    let inbound = 0;
    w.b.wss.on('connection', () => { inbound++; });
    const N = 30;
    const ws = new WebSocket(`ws://127.0.0.1:${w.a.port}/play`);
    await new Promise((ok, no) => { ws.on('open', ok); ws.on('error', no); });
    const answers = [];
    for (let i = 0; i < N; i++) answers.push(await new Promise((ok) => { ws.once('message', (d) => ok(Buffer.from(d).length)); ws.send(m2); }));
    ws.close();
    await until(5000, () => inbound >= N);
    await wait(500);
    console.log(`  FACTS: ${N} copies of the held final mark answered sizes ${JSON.stringify([...new Set(answers)])}; WebSockets A opened to its one peer B: ${inbound}`);
    assert.ok(inbound <= 1, `${inbound} outbound WebSockets from A to B for ${N} stranger copies of one held mark (one receipt)`);
  } finally { await w.close(); }
});
