// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// ONE ENTRY PER SESSION KEY IN A HEAD-TO-HEAD ROUND (kanban #1479, feedback #007 by Hexbox Tools, 2026-11-11): the seat count skipped every entry of the
// entering key, so one session key stood with rock, paper and scissors and revealed only the move that beat the honest player. Now a second entry of the
// same session key is refused at the door; the honest player and a second real player still take the round's two seats.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { b32 } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { RPS, RPS_CORE_HASH, RPS_CONFIG_HASH, RPS_GAME_ID } from './plugins/rps/index.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE };
const ROCK = 0, PAPER = 1, SCISSORS = 2;
const mk = (n) => ({ name: `p${n}`, key: b32(0x90 + n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0], session: ed25519.utils.randomSecretKey() });

test('#1479 one session key cannot stand three times with rock, paper and scissors; a second real player still gets the other seat', async () => {
  const w = await lockRound({ stakeMsat: 0n, serveOpts: { plugins: [NEXTBLOCK, RPS] }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 25000 });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const enter = async (who, move) => {
      try { await lockAndPlay(w, who, { session: who.session, hidden: { move, salt: new Uint8Array(randomBytes(32)) }, noMarks: true, only: [], feeLock: false }); return 'taken'; }
      catch (e) { return String(e.message).split('\n')[0].slice(0, 200); }
    };
    const honest = await enter(mk(1), ROCK);
    const attacker = mk(2);
    const a1 = await enter(attacker, ROCK), a2 = await enter(attacker, PAPER), a3 = await enter(attacker, SCISSORS);
    console.log('  FACTS (#1479):', JSON.stringify({ honest, a1, a2, a3 }));
    assert.equal(honest, 'taken');
    assert.equal(a1, 'taken', 'the first entry of a key is a normal entry');
    assert.match(a2, /one entry per session key|already seats/, `a second entry of the same key was taken: ${a2}`);
    assert.match(a3, /one entry per session key|already seats/, `a third entry of the same key was taken: ${a3}`);
    assert.equal(w.nodes[0].round.entriesOf(w.rid).length, 2, 'the round holds exactly the two players');
  } finally { await w.close(); }
});

test('#1479 the key rule itself: an attacker who enters first, while a seat is free, cannot enter again with another move', async () => {
  const w = await lockRound({ stakeMsat: 0n, serveOpts: { plugins: [NEXTBLOCK, RPS] }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 25000 });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const enter = async (who, move) => {
      try { await lockAndPlay(w, who, { session: who.session, hidden: { move, salt: new Uint8Array(randomBytes(32)) }, noMarks: true, only: [], feeLock: false }); return 'taken'; }
      catch (e) { return String(e.message).split('\n')[0].slice(0, 200); }
    };
    const attacker = mk(3);
    const a1 = await enter(attacker, ROCK), a2 = await enter(attacker, PAPER);
    const honest = await enter(mk(4), SCISSORS);
    console.log('  FACTS (#1479 first):', JSON.stringify({ a1, a2, honest }));
    assert.equal(a1, 'taken');
    assert.match(a2, /one entry per session key/, `a second entry of the same key took the free seat: ${a2}`);
    assert.equal(honest, 'taken', 'the real second player kept the seat');
  } finally { await w.close(); }
});
