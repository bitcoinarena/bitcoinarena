// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 a45-refute-22-s1-1 (refutes #1856's honest path): the 4 MB bound (PEER_LISTING_BYTES) put on a peer's
// GET /season-rounds answer drops HONEST seats. GET /season-rounds is not paged and not capped: a seat answers with every
// round with entries in up to SEASON_DAYS_MAX (90) days, each round ~1.2-1.7 kB (contract hex, its signature, entries).
// A seat that held ~3,500 free rounds with one entry in the week (one every ~3 min; the keepers post a free round every 90 s,
// an RPS grid 10,800 a day) answers > 4 MB, so every other seat now reads it as "not answered": the network board, the
// weekly badge and the leaderboard payout lose every busy honest seat. Before #1856 the answer was read.
// Safe: an honest seat's own /season-rounds answer is one its peers read (the bound fits the answer, or the answer is paged).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serve } from '../src/server.js';
import { openStore } from '../src/store.js';
import { contractFor, b32, opts } from './window-fixture.js';
import { encodeRoundContract, encodeEntryContract, roundId, entryId } from '../../arena-protocol/src/contracts.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { HOSTED, NEXTBLOCK_GAME_ID } from './plugins/hosted.js';

const SEATS = [b32(0x31), b32(0x32)].map((s) => s); // committee keys only need to be 32 bytes here
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

test('#1489 a45-refute-22-s1-1: an honest busy seat\'s own GET /season-rounds answer is read by its peer', async () => {
  const game = toHex(NEXTBLOCK_GAME_ID);
  const a = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, ...opts });
  let b;
  try {
    // seat A: an honest week - 3,500 free rounds with one entry each (one every ~173 s)
    const now = Date.now(), N = 3500;
    a.round.db.exec('BEGIN');
    for (let n = 0; n < N; n++) writeFreeRound(a.round, n, now - 7 * 24 * HOUR + 60000 + n * Math.floor((7 * 24 * HOUR - 120000) / N));
    a.round.db.exec('COMMIT');
    const own = await fetch(`http://127.0.0.1:${a.port}/season-rounds?game=${game}&days=7`);
    assert.equal(own.status, 200);
    const text = await own.text();
    const held = JSON.parse(text);
    assert.equal(held.rounds.length, N, 'seat A hands on every round of its week');
    console.log(`seat A's honest /season-rounds answer: ${held.rounds.length} rounds, ${text.length} bytes (bound 4194304)`);

    // seat B asks seat A (its only peer) for the network season of the same week
    b = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, peers: [`http://127.0.0.1:${a.port}`], ...opts });
    const r = await fetch(`http://127.0.0.1:${b.port}/season?game=nextblock&scope=network&days=7`);
    assert.equal(r.status, 200);
    const j = await r.json();
    console.log('seat B network season seats', j.seats);
    assert.equal(j.seats.asked, 1);
    assert.equal(j.seats.answered, 1, 'an honest seat\'s own, unpadded /season-rounds answer is read by its peer, not dropped as oversized');
  } finally {
    await b?.close?.();
    await a.close?.();
  }
});

test('#2273: every page of an honest busy seat\'s GET /season-rounds fits the 4 MB read bound and the pages hand on every round once', async () => {
  const a = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, ...opts });
  try {
    const game = toHex(NEXTBLOCK_GAME_ID);
    const now = Date.now(), N = 3500;
    a.round.db.exec('BEGIN');
    for (let n = 0; n < N; n++) writeFreeRound(a.round, n, now - 7 * 24 * HOUR + 60000 + n * Math.floor((7 * 24 * HOUR - 120000) / N));
    a.round.db.exec('COMMIT');
    const seen = new Set(); let after = '', pages = 0;
    for (;;) {
      const r = await fetch(`http://127.0.0.1:${a.port}/season-rounds?game=${game}&days=7&page=1&after=${after}`);
      assert.equal(r.status, 200);
      const t = await r.text();
      assert.ok(t.length <= 4 * 1024 * 1024, `page ${pages} is ${t.length} bytes`);
      const j = JSON.parse(t); pages++;
      assert.equal(j.roundKeys, true);
      for (const x of j.rounds) { assert.ok(!seen.has(x.roundId), 'a round on two pages'); assert.ok(x.roundId > after); seen.add(x.roundId); }
      if (!j.next) break;
      after = j.next;
    }
    console.log(`${N} rounds in ${pages} pages`);
    assert.equal(seen.size, N);
    assert.ok(pages >= 2);
    const bad = await fetch(`http://127.0.0.1:${a.port}/season-rounds?game=${game}&days=7&page=1&after=zz`);
    assert.equal(bad.status, 400);
  } finally {
    await a.close?.();
  }
});
