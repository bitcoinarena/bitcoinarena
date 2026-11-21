// kanban #3057: the card's test
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Audit 2026-11-19 r4, play round 2, finding 1: GET /canonical REBUILDS A WHOLE RUN FOR EVERY STRANGER'S REQUEST (gap in #2743).
// #2743 cached GET /transcript (round.handOver) per chain head, but its fix idea's "same for /replay/transcript" was not done,
// and GET /canonical (round.canonicalTranscript) - the same decode of every batch row, checkTranscript, encodeTranscript and
// transcriptHash - is still built from scratch on the seat's one thread on every public request. A player cuts a run into
// one-tick signed batches (10,800 rows) whose marks the committee receipts; anyone then loops GET /canonical.
// Safe: a repeat GET /canonical of an unchanged run costs no more than a lookup - 40 requests do not hold the thread for seconds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { assumeAssigned } from './assignment.js';
import { rand, WINDOW_MS, WINNER, GENESIS_HASH, wordsAt, contractFor, opts, presentDay } from './window-fixture.js';
import { testNow, skipTo } from './test-clock.js';
import { encodeRoundContract, roundId, encodeEntryContract, entryId } from '../../arena-protocol/src/contracts.js';
import { encodeInputBatch, batchId } from '../../arena-protocol/src/batch.js';
import { encodeCheckpoint, checkpointId, NO_PREVIOUS, joinSigned } from '../../arena-protocol/src/checkpoint.js';
import { encodeCheckpointReceipt, receiptId, joinSignedReceipt } from '../../arena-protocol/src/receipt.js';
import { HOSTED } from './plugins/hosted.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';

test('audit-play-r4-2-1: 40 strangers\' GET /canonical of one long receipted run hold the seat\'s thread for seconds', { timeout: 300000 }, async () => {
  const mk = () => serve(openStore(':memory:'), { plugins: HOSTED, port: 0, ...opts });
  const a = await mk(); const b = await mk();
  for (const [d, o] of [[a, b], [b, a]]) { const there = [`http://127.0.0.1:${o.port}`]; d.verifier.peers = there; d.stakeSecrets.peers = there; d.dkg.peers = there; }
  try {
    const c = presentDay({ ...contractFor([a.round.pubkey, b.round.pubkey], BigInt(WINDOW_MS), [a, b].map((d) => `http://127.0.0.1:${d.port}`)), stakeMsat: 0n, federationId: new Uint8Array(32) }, testNow() + 3600000);
    const rid = roundId(c);
    for (const d of [a, b]) {
      assert.equal((await fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: encodeRoundContract(c) })).status, 201);
      assumeAssigned(d.round, rid, c.nodes);
    }
    skipTo(Number(c.committeeTimeMs) + 20);
    const session = ed25519.utils.randomSecretKey();
    const entry = { roundId: rid, playerPubkey: WINNER.key, sessionPubkey: ed25519.getPublicKey(session),
      stakeCommitment: rand(32), stakeMsat: 0n, feeMsat: 0n, donationMsat: 0n, joinTick: 0, worldSecret: WINNER.worldSecret,
      vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32),
      stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n },
      claimKeyAttestationRef: new Uint8Array(32) };
    const eid = entryId(entry);
    for (const d of [a, b]) { const r = await fetch(`http://127.0.0.1:${d.port}/entry`, { method: 'POST', body: encodeEntryContract(entry) }); assert.equal(r.status, 201, await r.text()); }
    // the first mark at tick 0 over the genesis chain, then the run one tick per batch, then a mark at its end
    const signedMark = (m) => joinSigned(encodeCheckpoint(m), ed25519.sign(checkpointId(m), session));
    const receiptFrom = (secret, id) => { const r = { checkpointId: id, nodePubkey: schnorr.getPublicKey(secret), receivedAtMs: BigInt(testNow()) };
      return joinSignedReceipt(encodeCheckpointReceipt(r), schnorr.sign(receiptId(r), secret)); };
    let prev = GENESIS_HASH;
    const ticks = Math.min(BLOCK_TICKS, 10800);
    const b0 = { roundId: rid, entryId: eid, previousHash: prev, firstTick: 0, ticks: [wordsAt(0)], liquidations: [], loads: [] };
    a.round.batch(encodeInputBatch(b0)); prev = batchId(b0);
    const m0 = { roundId: rid, entryId: eid, tick: 1, stateHash: rand(32), inputChainHash: prev, previousHash: NO_PREVIOUS };
    a.round.checkpoint(signedMark(m0));
    for (let t = 1; t < ticks; t++) {
      const bt = { roundId: rid, entryId: eid, previousHash: prev, firstTick: t, ticks: [wordsAt(t)], liquidations: [], loads: [] };
      a.round.batch(encodeInputBatch(bt));
      prev = batchId(bt);
    }
    const m1 = { roundId: rid, entryId: eid, tick: ticks, stateHash: rand(32), inputChainHash: prev, previousHash: checkpointId(m0) };
    a.round.checkpoint(signedMark(m1));
    for (const m of [m0, m1]) a.round.takeReceipt(receiptFrom(b.round.identity.secret, checkpointId(m)));
    { const cc = a.round.canonicalTranscript(rid, eid); console.log('  direct canonical ticks', cc.ticks, 'marks', cc.marks); }
    // the keep-alive sockets of the setup's POSTs went stale while the run was stored: one warm-up ask, retried once
    try { await (await fetch(`http://127.0.0.1:${a.port}/canonical?round=00`)).arrayBuffer(); } catch { /* a stale socket */ }
    const q = `http://127.0.0.1:${a.port}/canonical?round=${toHex(rid)}&entry=${toHex(eid)}`;
    const one0 = Date.now(); const r0 = await fetch(q); const body0 = await r0.arrayBuffer(); const oneMs = Date.now() - one0;
    assert.equal(r0.status, 200, Buffer.from(body0).toString());
    assert.equal(r0.headers.get('x-ticks'), String(ticks));
    // the same door the transcript one (#2743) cached, for comparison
    const tq = `http://127.0.0.1:${a.port}/transcript?round=${toHex(rid)}&entry=${toHex(eid)}`;
    await (await fetch(tq)).arrayBuffer();
    const tt0 = Date.now(); await Promise.all(Array.from({ length: 40 }, () => fetch(tq).then((r) => r.arrayBuffer()))); const transcriptMs = Date.now() - tt0;
    const rq = `http://127.0.0.1:${a.port}/replay/transcript?round=${toHex(rid)}&entry=${toHex(eid)}`;
    const rr0 = Date.now(); await Promise.all(Array.from({ length: 40 }, () => fetch(rq).then((r) => r.arrayBuffer()))); const replayMs = Date.now() - rr0;
    const h = monitorEventLoopDelay({ resolution: 5 }); h.enable();
    const t0 = Date.now();
    await Promise.all(Array.from({ length: 40 }, () => fetch(q).then((r) => r.arrayBuffer())));
    const allMs = Date.now() - t0; h.disable();
    console.log(`  FACTS: a ${ticks}-tick run in ${ticks} batches, 2 marks receipted; one GET /canonical ${oneMs} ms; 40 GETs /canonical ${allMs} ms `
      + `(longest event-loop stall ${(h.max / 1e6).toFixed(0)} ms); 40 GETs /transcript (cached by #2743) ${transcriptMs} ms; 40 GETs /replay/transcript ${replayMs} ms`);
    assert.ok(allMs < 2000, `40 strangers' GET /canonical of one run held the seat for ${allMs} ms (each a whole rebuild, ${oneMs} ms; /transcript, cached, ${transcriptMs} ms)`);
  } finally { await a.close(); await b.close(); }
});
