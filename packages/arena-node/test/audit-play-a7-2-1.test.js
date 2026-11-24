// Audit 2026-11-24 play round 2, finding 1: THE #3057 DOOR CACHE IS KEYED BY THE ID'S SPELLING, NOT ITS BYTES.
// doorCacheKey keeps `round` and `entry` as the query text (server.js doorCacheKey), while the doors read them with
// Buffer.from(x, 'hex'), which takes either letter case and stops at the first non-hex character. So the same run is
// asked under 40 spellings (letter case toggled, or a junk tail after the 64 hex digits) and every one is a cache miss:
// each GET /canonical and GET /replay/transcript rebuilds the whole run on the seat's thread, as before #3057.
// Safe: 40 differently spelled asks of one unchanged run cost what 40 identical asks cost (no rebuild per spelling).
// (kanban #3584: an id with a junk tail is no id - those spellings are refused, 400, without a rebuild; the case-toggled ones answer the run)
// (setup copied from the card test audit-play-3057.test.js)
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

test('audit-play-a7-2-1: 40 spellings of one run id rebuild GET /canonical and /replay/transcript each time (gap in #3057)', { timeout: 300000 }, async () => {
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
    // the same id under other spellings: letters' case toggled by the bits of i, or a junk tail after the 64 digits
    const spell = (h, i) => { let k = 0; return h.replace(/[a-f]/g, (ch) => ((i >> (k++ % 20)) & 1 ? ch.toUpperCase() : ch)); };
    const spellings = Array.from({ length: 40 }, (_, i) => (i % 2 ? spell(toHex(eid), i + 1) : `${toHex(eid)}z${i}`));
    for (const s of spellings) assert.equal(Buffer.from(s, 'hex').toString('hex'), toHex(eid), 'every spelling is the same 32 bytes');
    const same0 = Date.now();
    for (let i = 0; i < 40; i++) await (await fetch(q)).arrayBuffer();
    const sameMs = Date.now() - same0;
    const h = monitorEventLoopDelay({ resolution: 5 }); h.enable();
    const t0 = Date.now();
    const got = [];
    const want = (s) => (s.length === 64 ? 200 : 400);   // a junk tail after the 64 digits is refused (kanban #3584)
    for (const s of spellings) { const r = await fetch(`http://127.0.0.1:${a.port}/canonical?round=${toHex(rid)}&entry=${s}`); await r.arrayBuffer(); got.push([s, r.status]); }
    const allMs = Date.now() - t0;
    const r0x = Date.now();
    for (const s of spellings) { const r = await fetch(`http://127.0.0.1:${a.port}/replay/transcript?round=${toHex(rid)}&entry=${s}`); await r.arrayBuffer(); got.push([s, r.status]); }
    const replayMs = Date.now() - r0x; h.disable();
    console.log(`  FACTS: a ${ticks}-tick run; one GET /canonical ${oneMs} ms; 40 asks of one spelling ${sameMs} ms; `
      + `40 spellings /canonical ${allMs} ms, /replay/transcript ${replayMs} ms (longest stall ${(h.max / 1e6).toFixed(0)} ms)`);
    assert.ok(allMs < Math.max(2000, 3 * sameMs), `40 spellings of one entry id held the seat ${allMs} ms in GET /canonical (one spelling 40 times: ${sameMs} ms; one rebuild ${oneMs} ms)`);
    assert.ok(replayMs < Math.max(2000, 3 * sameMs), `40 spellings of one entry id held the seat ${replayMs} ms in GET /replay/transcript`);
    for (const [s, st] of got) assert.equal(st, want(s), `${s}: a case-toggled id answers the run, one with a junk tail is refused`);
  } finally { await a.close(); await b.close(); }
});
