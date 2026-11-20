// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// audit gossip r1-1: THE DOOR CACHE OF GET /season-rounds (kanban #2901, #2910) IS KEYED BY THE WHOLE QUERY TEXT AND HOLDS 2048 FULL ANSWERS FOR 60 S.
// server.js keeps every 200 answer of GET /season-rounds, /census and /served under `url.pathname + url.search`, up to 2048 entries, each the
// whole body (DOOR_SLOW_CACHE_MS = 60 s). A stranger adds a junk parameter (`&x=<n>`) the door ignores: every request is a miss, and its full
// answer - an unpaged /season-rounds of a busy seat is several MB (#2273) - is kept. 2048 distinct queries hold 2048 copies of it.
// Safe: queries that differ only in what the door ignores do not each keep a full copy of the answer (the cache's memory stays bounded).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serve } from '../src/server.js';
import { openStore } from '../src/store.js';
import { contractFor, b32, opts } from './window-fixture.js';
import { encodeRoundContract, encodeEntryContract, roundId, entryId } from '../../arena-protocol/src/contracts.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { NEXTBLOCK_GAME_ID, HOSTED } from './plugins/hosted.js';

const SEATS = [b32(0x31), b32(0x32)];
const HOUR = 3600000;

function writeFreeRound(round, n, startMs) {
  const db = round.db;
  const contract = { ...contractFor(SEATS, 3000n, ['wss://r.example']), gameId: NEXTBLOCK_GAME_ID, stakeMsat: 0n, startTimeMs: BigInt(startMs), censusHeight: 900000 + n };
  const rid = roundId(contract);
  db.prepare('INSERT INTO rounds (round_id, contract, state, opened_ms) VALUES (?, ?, 0, ?)').run(rid, encodeRoundContract(contract), 1);
  const e = { roundId: rid, playerPubkey: b32(0x51), sessionPubkey: b32(0x60), stakeCommitment: b32(0x70), stakeMsat: 0n,
    feeMsat: 0n, donationMsat: 0n, joinTick: 0, worldSecret: b32(0), vssSharesRef: b32(0x80),
    stakePoint: Uint8Array.from([2, ...b32(0x90)]), feePreimage: b32(0), stakeLockOutpoint: { txid: b32(0xa0), outIdx: 0n },
    feeLockOutpoint: { txid: b32(0), outIdx: 0n }, claimKeyAttestationRef: b32(0) };
  db.prepare('INSERT INTO entries (entry_id, round_id, contract, joined_ms) VALUES (?, ?, ?, ?)').run(entryId(e), rid, encodeEntryContract(e), 2);
}

test('audit gossip r1-1: junk query parameters on GET /season-rounds do not make the door cache keep a full answer copy each', async () => {
  const a = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, ...opts });
  try {
    const game = toHex(NEXTBLOCK_GAME_ID);
    const now = Date.now(), N = 3000;
    a.round.db.exec('BEGIN');
    for (let n = 0; n < N; n++) writeFreeRound(a.round, n, now - 7 * 24 * HOUR + 60000 + n * Math.floor((7 * 24 * HOUR - 120000) / N));
    a.round.db.exec('COMMIT');
    const base = `http://127.0.0.1:${a.port}`;
    const first = await fetch(`${base}/season-rounds?game=${game}&days=7`);
    assert.equal(first.status, 200);
    const size = (await first.arrayBuffer()).byteLength;
    if (global.gc) global.gc();
    const before = process.memoryUsage();
    const K = 300;
    for (let i = 0; i < K; i++) {
      const r = await fetch(`${base}/season-rounds?game=${game}&days=7&x=${i}`);
      assert.equal(r.status, 200);
      await r.arrayBuffer();
    }
    if (global.gc) global.gc();
    await new Promise((go) => setTimeout(go, 200));
    if (global.gc) global.gc();
    const after = process.memoryUsage();
    const grewMB = ((after.arrayBuffers + after.heapUsed) - (before.arrayBuffers + before.heapUsed)) / 1048576;
    console.log(`  FACTS: one answer ${(size / 1048576).toFixed(2)} MB; ${K} stranger queries with a junk parameter; heap+buffers grew ${grewMB.toFixed(1)} MB (${(K * size / 1048576).toFixed(0)} MB if every copy is kept)`);
    assert.ok(grewMB < 64, `the seat kept ${grewMB.toFixed(1)} MB after ${K} junk-parameter queries of one ${(size / 1048576).toFixed(2)} MB answer: the door cache holds a full copy per query text (up to 2048 for 60 s)`);
  } finally { await a.close?.(); }
});

