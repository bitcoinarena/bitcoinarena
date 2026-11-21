// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 round 3, head-to-head: A STAKE LOCK WITH NO FEE LOCK HOLDS A SEAT OF A PAID TABLE UNTIL THE CLOSE, THEN SEATS NOBODY - THE ROUND IS VOID.
// The door counts an entry whose stake lock is verified (fee lock still missing) as seated (round.js seatedEntriesOf: "a stake lock still waiting
// for its fee lock holds its seat at the door"), with no time limit; from the close the same entry is not played (#1861: only a seen stake, stake
// AND fee lock, seats it). So an attacker who enters a paid RPS table next to one honest player and hands only his stake lock (no fee, the lock
// itself comes back as VOID) makes every seat refuse the real second player ("table is full", #2634) and, at the close, leaves the honest player
// alone: the round is VOID. One cheap lock per round voids every paid head-to-head round. Safe: a second honest player who locks both parts
// before the close is seated, and the honest player is played (not VOID).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { lockRound, lockAndPlay, closeRound } from './lock-round-fixture.js';
import { b32 } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { RPS, RPS_CORE_HASH, RPS_CONFIG_HASH, RPS_GAME_ID } from './plugins/rps/index.js';
import { decodePlayerResult, splitSignedResult } from '../../arena-protocol/src/result.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { lockFieldsToJson } from '../../arena-protocol/src/stake-lock.js';

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE };
const ROCK = 0, SCISSORS = 2;
const mk = (n) => ({ name: `p${n}`, key: b32(0x30 + n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });
const salt = () => new Uint8Array(randomBytes(32));
const results = (w, eid) => w.nodes.map((d) => d.round.results(w.rid, eid).map((r) => { const p = decodePlayerResult(splitSignedResult(r.bytes).body); return `${p.outcome} ${p.score}`; }));

test('#1489 r3 h2h-1: a stake lock with no fee lock blocks the paid table until the close and the honest player\'s round is VOID', async () => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS], entryCloseGraceMs: 15000, h2hHandoutLeadMs: 1000 }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 25000 });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const sh = salt(), sc = salt();
    const honest = await lockAndPlay(w, mk(1), { hidden: { move: ROCK, salt: sh }, noMarks: true });
    // the attacker: entry at every seat, then ONLY its stake lock (no fee lock, ever)
    const attacker = await lockAndPlay(w, mk(2), { hidden: { move: ROCK, salt: salt() }, noMarks: true, only: [] });
    const stakeOnly = [];
    for (const d of w.nodes) {
      const r = await fetch(`http://127.0.0.1:${d.port}/lock?entry=${toHex(attacker.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(attacker.fields)) });
      stakeOnly.push(`${r.status} ${(await r.text()).slice(0, 80)}`);
    }
    // a real second player, well before the close, both locks
    let second, secondPlay = null;
    try { secondPlay = await lockAndPlay(w, mk(3), { hidden: { move: SCISSORS, salt: sc }, noMarks: true }); second = 'taken'; }
    catch (e) { second = String(e.message).split('\n')[0].slice(0, 200); }
    skipTo(Number(w.c.entryCloseMs) + 500);
    for (const d of w.nodes) {
      await fetch(`http://127.0.0.1:${d.port}/reveal?entry=${toHex(honest.eid)}`, { method: 'POST', body: JSON.stringify({ move: ROCK, salt: toHex(sh) }) });
      if (secondPlay) await fetch(`http://127.0.0.1:${d.port}/reveal?entry=${toHex(secondPlay.eid)}`, { method: 'POST', body: JSON.stringify({ move: SCISSORS, salt: toHex(sc) }) });
    }
    await closeRound(w);
    const got = { honest: results(w, honest.eid), attacker: results(w, attacker.eid), second: secondPlay ? results(w, secondPlay.eid) : null };
    console.log('  FACTS (#1489 r3 h2h-1):', JSON.stringify({ stakeOnly, second, got }));
    assert.equal(second, 'taken', `a real second player who locks stake and fee before the close was refused, because a stake lock with no fee lock held the seat: ${second}`);
    for (const per of got.honest) assert.ok(!per.includes('VOID 0'), `the honest player's round was VOID - the stake-only entry seated nobody at the close: ${JSON.stringify(got)}`);
  } finally { await w.close(); }
});
