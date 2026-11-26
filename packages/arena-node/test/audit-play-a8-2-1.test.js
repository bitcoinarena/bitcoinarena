// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Audit play a8 r2-1: GET /equivocation rebuilds a fork search over the whole stored mark chain for every public request
// (gap in #3057, which cached only /canonical and /replay/transcript). Round.equivocation decodes every checkpoint row of the
// entry and, for each of up to 72 kept offered marks, scans the whole chain (tick, then parent) - no door cache, no per-chain
// memo. A player marks every tick of a run (10,800 marks) and sends 64 stale-head marks naming no parent (each refused and kept
// as offered); then anybody loops GET /equivocation - each answer is a 204, yet each holds the seat's one thread.
// Safe: repeat GET /equivocation of an unchanged run costs no more than a lookup - 40 requests do not hold the thread for seconds.
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
import { encodeCheckpoint, checkpointId, NO_PREVIOUS, joinSigned } from '../../arena-protocol/src/checkpoint.js';
import { HOSTED } from './plugins/hosted.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';

test('audit-play-a8-2-1: 40 strangers\' GET /equivocation of one many-mark run hold the seat\'s thread for seconds', { timeout: 600000 }, async () => {
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
    const signedMark = (m) => joinSigned(encodeCheckpoint(m), ed25519.sign(checkpointId(m), session));
    // the run one tick per batch, a mark after every batch (round.checkpoint asks only a later tick and held inputs)
    let prev = GENESIS_HASH; let prevMark = NO_PREVIOUS;
    const ticks = Math.min(BLOCK_TICKS, 10800);
    for (let t = 0; t < ticks; t++) {
      const bt = { roundId: rid, entryId: eid, previousHash: prev, firstTick: t, ticks: [wordsAt(t)], liquidations: [], loads: [] };
      a.round.batch(encodeInputBatch(bt));
      prev = batchId(bt);
      const m = { roundId: rid, entryId: eid, tick: t + 1, stateHash: rand(32), inputChainHash: prev, previousHash: prevMark };
      a.round.checkpoint(signedMark(m));
      prevMark = checkpointId(m);
    }
    // 64 stale-head marks naming a parent nobody holds: each refused ('does not follow the chain head') and kept as offered
    let refused = 0;
    for (let i = 0; i < 64; i++) {
      const m = { roundId: rid, entryId: eid, tick: ticks + 100 + i, stateHash: rand(32), inputChainHash: prev, previousHash: rand(32) };
      try { a.round.checkpoint(signedMark(m)); } catch (e) { if (/chain head/.test(e.message)) refused++; }
    }
    assert.equal(refused, 64);
    const d0 = Date.now(); const direct = a.round.equivocation(rid, eid); const directMs = Date.now() - d0;
    try { await (await fetch(`http://127.0.0.1:${a.port}/equivocation?round=00`)).arrayBuffer(); } catch { /* a stale socket */ }
    const q = `http://127.0.0.1:${a.port}/equivocation?round=${toHex(rid)}&entry=${toHex(eid)}`;
    const one0 = Date.now(); const r0 = await fetch(q); await r0.arrayBuffer(); const oneMs = Date.now() - one0;
    const h = monitorEventLoopDelay({ resolution: 5 }); h.enable();
    const t0 = Date.now();
    await Promise.all(Array.from({ length: 40 }, () => fetch(q).then((r) => r.arrayBuffer())));
    const allMs = Date.now() - t0; h.disable();
    console.log(`  FACTS: ${ticks} marks, 64 offered; direct equivocation() ${directMs} ms (${direct.length} pairs); one GET /equivocation ${oneMs} ms `
      + `(status ${r0.status}); 40 GETs ${allMs} ms (longest event-loop stall ${(h.max / 1e6).toFixed(0)} ms)`);
    assert.ok(allMs < 2000, `40 strangers' GET /equivocation of one run held the seat for ${allMs} ms (each a whole chain scan, ${oneMs} ms)`);
  } finally { await a.close(); await b.close(); }
});
