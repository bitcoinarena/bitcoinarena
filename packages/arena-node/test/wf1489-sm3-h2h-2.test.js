// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 state machine audit (sm3-h2h-2): A HEAD-TO-HEAD ENTRY TAKES ITS SEAT AFTER THE OPPONENT'S MOVE IS PUBLIC - A FREE OPTION.
// Machine: a paying head-to-head entry: entered (no lock, no seat, #1437) -> seated (its stake lock verified here) -> decided. The /lock door takes a
// lock new to this seat until the entry close + ENTRY_CLOSE_GRACE_MS (15 s live, kanban #1260 lockAfterCloseRefusal) - a grace sized for a join on its
// way. A head-to-head round's moves are revealed from the entry close on (the page at close + 120 ms) and served to anyone by GET /reveals, so for
// ~15 s a player holds the opponent's move and his own committed one, and can still choose whether to play. The attacker enters before the close with
// his handout and commitment and holds his stake lock back. If his move wins he hands the lock (seated, verified in 2-3 s, well before the reveal
// deadline at close + >= 10 s) and reveals: he wins the honest player's stake. If it loses he hands nothing: he is no member, the honest player sits
// alone and is VOID - the attacker risks nothing. Every honest opponent (the test bot included) pays into a game the other side only plays when won.
// Invariant: no head-to-head entry takes a seat once a move of its round can be known (from the entry close on).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { lockRound, lockAndPlay, closeRound, untilSettled } from './lock-round-fixture.js';
import { b32 } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { RPS, RPS_CORE_HASH, RPS_CONFIG_HASH, RPS_GAME_ID } from './plugins/rps/index.js';
import { decodePlayerResult, splitSignedResult } from '../../arena-protocol/src/result.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { lockFieldsToJson } from '../src/stake-lock-signer-node.js';

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE };
const ROCK = 0, PAPER = 1, SCISSORS = 2;
const BEATS = { [ROCK]: PAPER, [PAPER]: SCISSORS, [SCISSORS]: ROCK };   // the move that beats each move
const mk = (n) => ({ name: `p${n}`, key: b32(0x60 + n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });
const own = (w, eid) => w.nodes.map((d) => d.round.results(w.rid, eid).filter((r) => toHex(decodePlayerResult(splitSignedResult(r.bytes).body).nodePubkey) === toHex(d.round.pubkey))
  .map((r) => { const p = decodePlayerResult(splitSignedResult(r.bytes).body); return `${p.outcome} ${p.score}`; }).join());

test('#1489 sm3-h2h-2: a player who held his stake lock back hands it after reading the opponent\'s reveal, takes the seat, and wins', { timeout: 110000 }, async () => {
  // the live grace (main.js: ENTRY_CLOSE_GRACE_MS, 15 s)
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS], entryCloseGraceMs: 15000 }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 4000 });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const sy = new Uint8Array(randomBytes(32)), sx = new Uint8Array(randomBytes(32));
    // the honest player: entry and both locks, move ROCK
    const y = await lockAndPlay(w, mk(1), { hidden: { move: ROCK, salt: sy }, noMarks: true });
    // the attacker commits PAPER and enters with his handout before the close; no seat is handed his stake lock
    const x = await lockAndPlay(w, mk(2), { hidden: { move: PAPER, salt: sx }, noMarks: true, feeFirst: true, only: [] });
    const seatedBefore = w.nodes.map((d) => d.round.seatedEntriesOf(w.rid, w.c.stakeMsat).length);
    // the entry close: the honest page reveals at close + 120 ms
    skipTo(Number(w.c.entryCloseMs) + 120);
    const yReveal = await Promise.all(w.nodes.map((d) => fetch(`http://127.0.0.1:${d.port}/reveal?entry=${toHex(y.eid)}`, { method: 'POST', body: JSON.stringify({ move: ROCK, salt: toHex(sy) }) }).then((r) => r.status)));
    // the attacker reads the public reveals and sees his committed move wins
    skipTo(Number(w.c.entryCloseMs) + 1000);
    const pub = await (await fetch(`http://127.0.0.1:${w.nodes[0].port}/reveals?round=${toHex(w.rid)}`)).json();
    const theirs = pub.reveals.find((r) => r.entry === toHex(y.eid));
    const wins = theirs && BEATS[theirs.move] === PAPER;
    // ...so now, 1 s after the close, he hands his stake lock to every seat, and reveals
    const lockAnswers = wins ? await Promise.all(w.nodes.map((d) => fetch(`http://127.0.0.1:${d.port}/lock?entry=${toHex(x.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(x.fields)) })
      .then(async (r) => `${r.status} ${(await r.text()).slice(0, 60)}`))) : [];
    skipTo(Number(w.c.entryCloseMs) + 4000);
    const xReveal = await Promise.all(w.nodes.map((d) => fetch(`http://127.0.0.1:${d.port}/reveal?entry=${toHex(x.eid)}`, { method: 'POST', body: JSON.stringify({ move: PAPER, salt: toHex(sx) }) }).then((r) => r.status)));
    await closeRound(w);
    const settled = await untilSettled(w, 15000);
    const got = { seatedBefore, yReveal, sawTheirMove: theirs && theirs.move, wins, lockAnswers, xReveal, x: own(w, x.eid), y: own(w, y.eid), settlement: settled && settled.state };
    console.log('  FACTS sm3-h2h-2:', JSON.stringify(got));
    assert.deepEqual(seatedBefore, [1, 1], 'at the close only the honest player is seated');
    assert.ok(lockAnswers.every((a) => !a.startsWith('201')), `a stake lock handed after the opponent's move was public took a seat: ${JSON.stringify(got)}`);
    assert.ok(!got.x.includes('DELIVERED 2'), `the attacker, seated only once he knew he won, is signed the winner: ${JSON.stringify(got)}`);
  } finally { await w.close(); }
});
