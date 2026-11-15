// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #2860 (the owner's playtest 2026-11-15: RPS orders timed out at Beelink load ~28): a seat's profile had seasonRounds + signSeason at ~9 %
// and GET /season-rounds and /season in its [lag] lines - every seat asks every other for its season rounds, and the 30 s keep re-read the store
// and signed every round twice a minute per query. Kept 5 minutes now: an ask 4 minutes later is the same bytes from the keep, one 6 minutes
// later is read and signed again. Date is moved with node:test's mock timers.
import { test, mock } from 'node:test';
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


test('#2860 GET /season-rounds and /season are kept 5 minutes: the same bytes 4 min later, read again after 6 min', async () => {
  const a = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, ...opts });
  try {
    const game = toHex(NEXTBLOCK_GAME_ID);
    const t0 = Date.now(), N = 300;
    a.round.db.exec('BEGIN');
    for (let n = 0; n < N; n++) writeFreeRound(a.round, n, t0 - 3 * 24 * HOUR + n * 60000);
    a.round.db.exec('COMMIT');
    const base = `http://127.0.0.1:${a.port}`;
    const get = async (path) => (await fetch(base + path)).text();
    const q = `/season-rounds?game=${game}&days=7`, qs = `/season?game=${game}&days=7`;
    const first = await get(q), firstS = await get(qs);
    // a round added after the first read: not in the kept answer while it is kept
    writeFreeRound(a.round, N + 1, t0 - HOUR);
    mock.timers.enable({ apis: ['Date'], now: t0 + 4 * 60000 });
    const rounds = (t) => JSON.stringify(JSON.parse(t).rounds);
    assert.equal(rounds(await get(q)), rounds(first), '4 minutes later: the same signed rounds, from the keep (the head names the asked window)');
    assert.equal(await get(qs), firstS);
    mock.timers.setTime(t0 + 6 * 60000);
    const again = await get(q);
    assert.notEqual(rounds(again), rounds(first), '6 minutes later: read and signed again (the new round is in it)');
    assert.equal(JSON.parse(again).rounds.length, JSON.parse(first).rounds.length + 1);
  } finally { mock.timers.reset(); await a.close?.(); }
});
