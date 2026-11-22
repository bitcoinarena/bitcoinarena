// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
//
// AUDIT play r3-3: #forkFromPeers (verify.js:725) compares every peer mark with every mark of this seat, and computes hex() of
// both 231-byte records for EVERY pair before any tick test - O(marks^2) at about 34 us a pair, synchronously on the seat's
// thread, at every close of every played run, once per peer. Nothing bounds how many marks a run has: round.checkpoint only
// asks for a later tick and held inputs, so a player (role a) who marks every tick instead of once a second (MarkEvery 60)
// makes each honest seat's close hold its whole thread for (ticks)^2 x 34 us x peers - 600 ticks: ~12 s per peer.
// Safe: closing one run of a few hundred marks does not hold the seat's thread for seconds.
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

import { SIGNED_CHECKPOINT_BYTES } from '../../arena-protocol/src/checkpoint.js';
const until = async (ms, ok) => { for (let t = Date.now(); Date.now() - t < ms; await wait(100)) { const v = await ok(); if (v) return v; } return null; };

test('one run that marks every tick does not hold the seat\'s thread for seconds at its close', { timeout: 300000 }, async () => {
  const w = await signerNodes();
  try {
    const T = 600;
    const session = ed25519.utils.randomSecretKey();
    const entry = { roundId: w.rid, playerPubkey: WINNER.key, sessionPubkey: ed25519.getPublicKey(session),
      stakeCommitment: rand(32), stakeMsat: 0n, feeMsat: 0n, donationMsat: 0n, joinTick: 0, worldSecret: WINNER.worldSecret,
      vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32),
      stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n },
      claimKeyAttestationRef: new Uint8Array(32) };
    const eid = entryId(entry);
    for (const d of [w.a, w.b])
      assert.equal((await fetch(`http://127.0.0.1:${d.port}/entry`, { method: 'POST', body: encodeEntryContract(entry) })).status, 201);
    const st = init(seedWordForEntry(entry, RANDOMNESS));
    const hashNow = () => Uint8Array.from(stateHash(st).match(/../g).map((x) => parseInt(x, 16)));
    const frames = [];
    let prevBatch = GENESIS_HASH, prevMark = NO_PREVIOUS;
    for (let t = 0; t < T; t++) {
      step(st, ...wordsAt(t));
      const b = { roundId: w.rid, entryId: eid, previousHash: prevBatch, firstTick: t, ticks: [wordsAt(t)], liquidations: [] };
      frames.push(signedBatchOf(b, (id) => ed25519.sign(id, session)));
      prevBatch = batchId(b);
      const m = { roundId: w.rid, entryId: eid, tick: t + 1, stateHash: hashNow(), inputChainHash: prevBatch, previousHash: prevMark };
      frames.push(joinSigned(encodeCheckpoint(m), ed25519.sign(checkpointId(m), session)));
      prevMark = checkpointId(m);
    }
    for (const d of [w.a, w.b]) {
      const ws = new WebSocket(`ws://127.0.0.1:${d.port}/play`);
      await new Promise((ok, no) => { ws.on('open', ok); ws.on('error', no); });
      const answers = [];
      for (const f of frames) answers.push(await new Promise((ok) => { ws.once('message', (x, bin) => ok(bin ? 'receipt' : x.toString())); ws.send(f); }));
      ws.close();
      const bad = answers.filter((a) => a !== 'receipt' && !/^\d+$/.test(a));
      assert.equal(bad.length, 0, `a frame was refused: ${bad[0]}`);
    }
    await wait(500);
    assert.equal(Math.floor(w.a.round.checkpoints(w.rid, eid).bytes.length / SIGNED_CHECKPOINT_BYTES), T, 'A holds every mark');
    // THE THREAD WATCHED while A closes the round
    let maxLag = 0, last = Date.now();
    const tick = setInterval(() => { const now = Date.now(); maxLag = Math.max(maxLag, now - last - 20); last = now; }, 20);
    const t0 = Date.now();
    assert.equal(await say(w.a.port, `close ${toHex(w.rid)}`), 'closed');
    const got = await until(240000, () => w.a.round.results(w.rid, eid).length > 0);
    clearInterval(tick);
    console.log('  FACTS:', JSON.stringify({ marks: T, signedAtA: !!got, closeMs: Date.now() - t0, maxThreadHeldMs: maxLag }));
    assert.ok(got, 'A signed the run');
    assert.ok(maxLag < 2000, `closing one run of ${T} marks held seat A's thread ${maxLag} ms in one piece`);
  } finally { await w.close(); }
});
