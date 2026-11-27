// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Audit #1489 r40 play-1 (gap in #2743): GET /transcript keeps its built answer (round.handOver) in a cache of 256 keys, any
// (round, entry) pair a stranger names - one that holds nothing too - takes a key, and the oldest key is dropped. So a stranger
// who asks for 256 made-up pairs (each three cheap SELECTs) between two asks for one long run makes the seat rebuild that run
// (every batch row decoded, checked, encoded and hashed - 132 ms for 10,800 rows, #2743) on every round of the loop.
// Safe: the long run, asked again unchanged, is not rebuilt because strangers named other pairs in between.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { assumeAssigned } from './assignment.js';
import { rand, WINDOW_MS, WINNER, GENESIS_HASH, wordsAt, contractFor, opts, presentDay } from './window-fixture.js';
import { testNow, skipTo } from './test-clock.js';
import { encodeRoundContract, roundId, encodeEntryContract, entryId } from '../../arena-protocol/src/contracts.js';
import { encodeInputBatch, batchId } from '../../arena-protocol/src/batch.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { HOSTED } from './plugins/hosted.js';

test('wf1489-r40-play-1: 256 strangers\' GET /transcript of made-up pairs make the seat rebuild a long run', { timeout: 300000 }, async () => {
  const a = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, ...opts });
  try {
    const c = presentDay({ ...contractFor([a.round.pubkey], BigInt(WINDOW_MS), [`http://127.0.0.1:${a.port}`]), stakeMsat: 0n, federationId: new Uint8Array(32) }, testNow() + 3600000);
    const rid = roundId(c);
    assert.equal((await fetch(`http://127.0.0.1:${a.port}/round`, { method: 'POST', body: encodeRoundContract(c) })).status, 201);
    assumeAssigned(a.round, rid, c.nodes);
    skipTo(Number(c.committeeTimeMs) + 20);
    const session = ed25519.utils.randomSecretKey();
    const entry = { roundId: rid, playerPubkey: WINNER.key, sessionPubkey: ed25519.getPublicKey(session),
      stakeCommitment: rand(32), stakeMsat: 0n, feeMsat: 0n, donationMsat: 0n, joinTick: 0, worldSecret: WINNER.worldSecret,
      vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32),
      stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n },
      claimKeyAttestationRef: new Uint8Array(32) };
    const eid = entryId(entry);
    { const r = await fetch(`http://127.0.0.1:${a.port}/entry`, { method: 'POST', body: encodeEntryContract(entry) }); assert.equal(r.status, 201, await r.text()); }
    let prev = GENESIS_HASH;
    const N = 2000;
    for (let t = 0; t < N; t++) {
      const bt = { roundId: rid, entryId: eid, previousHash: prev, firstTick: t, ticks: [wordsAt(t)], liquidations: [], loads: [] };
      a.round.batch(encodeInputBatch(bt)); prev = batchId(bt);
    }
    // count the whole-run builds: #handOverBuilt's one read of every batch row
    const db = a.round.db; const prep = db.prepare.bind(db); let builds = 0;
    db.prepare = (sql) => { if (/^SELECT bytes FROM batches WHERE round_id = \? AND entry_id = \? ORDER BY seq$/.test(sql)) builds++; return prep(sql); };
    const base = `http://127.0.0.1:${a.port}`;
    try { await (await fetch(`${base}/transcript?round=00`)).arrayBuffer(); } catch { /* stale keep-alive */ }
    const q = `${base}/transcript?round=${toHex(rid)}&entry=${toHex(eid)}`;
    const ask = async (u) => { const r = await fetch(u); await r.arrayBuffer(); return r; };
    builds = 0;
    const r0 = await ask(q); assert.equal(r0.status, 200); assert.equal(r0.headers.get('x-ticks'), String(N));
    await ask(q);
    assert.equal(builds, 1, 'the second ask of an unchanged run is answered from the cache (#2743)');
    const loops = 3;
    let ms = 0; let runBuilds = 0;
    for (let k = 0; k < loops; k++) {
      for (let i = 0; i < 260; i++) await ask(`${base}/transcript?round=${toHex(rand(32))}&entry=${toHex(rand(32))}`);
      const before = builds;
      const t0 = Date.now(); await ask(q); ms += Date.now() - t0;
      runBuilds += builds - before;
    }
    console.log(`  FACTS: a ${N}-batch run; ${loops} loops of 260 made-up pairs then the run: ${runBuilds} whole-run rebuilds of the unchanged run, its asks ${ms} ms in all`);
    assert.equal(runBuilds, 0, `the unchanged run was rebuilt ${runBuilds} more times because strangers named ${260 * loops} made-up (round, entry) pairs in between`);
  } finally { await a.close(); }
});
