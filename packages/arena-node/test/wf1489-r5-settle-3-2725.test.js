// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r5-settle-3: A STRANGER'S GET /season-rounds (and GET /season) WITH A NEW QUERY EACH TIME RE-READS THE WHOLE STORE.
// The doors are public. Their 30 s cache (seasonKept) is keyed by the query text - `${ids}|${days}` - and holds 32 entries. Every miss runs
// season-read.js seasonRounds, which SELECTs every round with entries, decodes every contract and reads each round of the window, and
// signs each settled account (signedSeasonRoundsJson), synchronously on the seat's event loop. The query is the stranger's to vary at no
// cost: `days` 1..90, any 64-hex game id (an id the seat does not host is taken as it is), and on /season-rounds a comma list of up to
// 16 ids, junk ids beside the real one. So every request misses and the seat re-reads its store and every round of the real game in the
// window each time (measured: 3,500 rounds, ~180 ms on the loop per padded query, 6 ms from the cache) - the weekly badge, the
// leaderboard payout and every page wait behind it. Safe: a query this seat already answered, padded with ids it does not host or a
// different `days`, does not cost a fresh read of the whole store each time (the cache cannot be cycled for free).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { serve } from '../src/server.js';
import { openStore } from '../src/store.js';
import { contractFor, b32, opts } from './window-fixture.js';
import { encodeRoundContract, encodeEntryContract, roundId, entryId } from '../../arena-protocol/src/contracts.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { HOSTED, NEXTBLOCK_GAME_ID } from './plugins/hosted.js';

const SEATS = [b32(0x31), b32(0x32)];
const HOUR = 3600000;

// (fixture from wf1489-a45-refute-22-s1-1.test.js)
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

const timed = async (url) => { const t = Date.now(); const r = await fetch(url); await r.arrayBuffer(); return { ms: Date.now() - t, status: r.status }; };

test('wf1489 r5-settle-3: junk ids and other days on GET /season-rounds do not make the seat re-read its whole store each time', async () => {
  const a = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, ...opts });
  try {
    const game = toHex(NEXTBLOCK_GAME_ID);
    const now = Date.now(), N = 3500;
    a.round.db.exec('BEGIN');
    for (let n = 0; n < N; n++) writeFreeRound(a.round, n, now - 7 * 24 * HOUR + 60000 + n * Math.floor((7 * 24 * HOUR - 120000) / N));
    a.round.db.exec('COMMIT');
    const base = `http://127.0.0.1:${a.port}`;
    // the honest read, once: cold, then from the cache
    const cold = await timed(`${base}/season-rounds?game=${game}&days=7`);
    const warm = await timed(`${base}/season-rounds?game=${game}&days=7`);
    assert.equal(cold.status, 200);
    // the stranger: the same game with a junk id beside it, a fresh one each time, and the days cycled
    const K = 12;
    let strangerMs = 0, slowest = 0;
    for (let i = 0; i < K; i++) {
      const junk = randomBytes(32).toString('hex');
      const r = await timed(`${base}/season-rounds?game=${game},${junk}&days=${1 + (i % 90)}`);
      assert.equal(r.status, 200);
      strangerMs += r.ms; slowest = Math.max(slowest, r.ms);
    }
    // and GET /season with a made-up game id: taken as it is, the store read all the same
    const junkSeason = await timed(`${base}/season?game=${randomBytes(32).toString('hex')}&days=3`);
    console.log(`  FACTS: ${N} rounds; honest cold ${cold.ms} ms, warm ${warm.ms} ms; ${K} stranger queries ${strangerMs} ms in all (slowest ${slowest} ms);`
      + ` /season with a made-up id ${junkSeason.ms} ms (status ${junkSeason.status})`);
    const bound = Math.max(150, Math.floor(cold.ms / 4));
    assert.ok(slowest <= bound, `a stranger's padded query cost ${slowest} ms of the seat's thread (the honest cold read ${cold.ms} ms): every new query re-reads the whole store`);
    assert.ok(strangerMs <= K * bound, `${K} padded queries held the seat ${strangerMs} ms`);
  } finally { await a.close?.(); }
});
