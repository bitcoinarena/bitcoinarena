// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 audit r6 (play) 12: GET /transcript REBUILDS A WHOLE RUN ON THE SEAT'S THREAD FOR EVERY STRANGER'S REQUEST.
// GET /transcript?round=&entry= (server.js) has no cache, no size bound and no caller check: each request runs
// round.handOver - every batch row of the run decoded, checkTranscript over the whole chain, encodeTranscript and
// transcriptHash - synchronously on the seat's one thread. A run is up to BLOCK_TICKS (10,800) ticks, and the player chooses
// how they are cut: one tick per signed batch is taken (round.batch has a ceiling per batch, no floor), so one entry's run
// is 10,800 batch rows. Round and entry ids are public (listing, explorer); anyone then sends GET /transcript in a loop and
// every request is the whole rebuild, holding every /play frame, receipt and close of every round behind it.
// Safe: serving a run's transcript again does not rebuild it from every row (a repeat of an unchanged run costs no more
// than a lookup), so 40 strangers' requests do not hold the seat's thread for seconds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { assumeAssigned } from './assignment.js';
import { rand, WINDOW_MS, WINNER, GENESIS_HASH, wordsAt, contractFor, opts, presentDay } from './window-fixture.js';
import { testNow, skipTo } from './test-clock.js';
import { encodeRoundContract, roundId, encodeEntryContract, entryId } from '../../arena-protocol/src/contracts.js';
import { encodeInputBatch, batchId } from '../../arena-protocol/src/batch.js';
import { HOSTED } from './plugins/hosted.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';

test('#1489-r6-play-12: 40 strangers\' GET /transcript of one long run hold the seat\'s thread for seconds', { timeout: 200000 }, async () => {
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
    // THE PLAYER'S RUN, ONE TICK PER BATCH (the door takes each signed; stored here straight, the same rows)
    let prev = GENESIS_HASH;
    const ticks = Math.min(BLOCK_TICKS, 10800);
    for (let t = 0; t < ticks; t++) {
      const b = { roundId: rid, entryId: eid, previousHash: prev, firstTick: t, ticks: [wordsAt(t)], liquidations: [], loads: [] };
      a.round.batch(encodeInputBatch(b));
      prev = batchId(b);
    }
    const q = `http://127.0.0.1:${a.port}/transcript?round=${toHex(rid)}&entry=${toHex(eid)}`;
    // the 10,800 stores above hold this one thread ~10 s - past the 5 s the seat keeps an idle connection, and the client's pool shares
    // the thread: let both sides' keep-alive timers run first, or the first GET goes out on a socket the seat is closing (ECONNRESET)
    await new Promise((r) => setTimeout(r, 50));
    const one0 = Date.now(); const r0 = await fetch(q); await r0.arrayBuffer(); const oneMs = Date.now() - one0;
    assert.equal(r0.status, 200);
    const h = monitorEventLoopDelay({ resolution: 5 }); h.enable();
    const t0 = Date.now();
    await Promise.all(Array.from({ length: 40 }, () => fetch(q).then((r) => r.arrayBuffer())));
    const allMs = Date.now() - t0; h.disable();
    console.log(`  FACTS: a ${ticks}-tick run in ${ticks} batches; one GET /transcript ${oneMs} ms; 40 GETs ${allMs} ms; longest event-loop stall ${(h.max / 1e6).toFixed(0)} ms`);
    assert.ok(allMs < 2000, `40 strangers' GET /transcript of one run held the seat for ${allMs} ms (each a whole rebuild, ${oneMs} ms)`);
  } finally { await a.close(); await b.close(); }
});
