// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 skeptic 2 on #1598 (918e302c0 + ab08fd0cd): THE DOOR IS CHECKED WHEN A LOCK ARRIVES, THE FEDERATION IS READ SECONDS LATER.
// Adapted to 1.9 by #2536 (kanban #1827): the reveal is read once 1.9 serves it (close + H2H_REVEAL_HOLD_MS, #1822); the seats' federation
// reads are still held until the attacker has submitted the winner, as the card has it.
// POST /lock runs lockAfterCloseRefusal (h2hLockRefusal) before it asks the federation (takeStakeLock -> verifyStakeLock -> port.status, a
// stock-client read in a lane, 2.2-2.7 s live, up to 107 s measured under load, #605) and nothing re-checks the door at the write. So one
// player enters rock, paper and scissors under three fresh session keys, each naming a stake outpoint of a federation transaction he has
// built but NOT submitted, and hands all three stake locks to every seat just BEFORE the entry close: every door passes (no reveal yet,
// the clock before the close). The federation reads are still on their way when the close comes; he reads the honest reveal on GET
// /reveals and submits only the transaction of the entry that beats it. Each seat's read then finds the winner's lock and no lock for
// the other two - every seat holds the winner's lock, so the #1788 threshold count is met: DELIVERED 2 at both seats.
// Safe behaviour: a head-to-head stake lock is not seated when the federation first holds it only after the round's moves can be revealed.
import { test } from 'node:test';
import { H2H_REVEAL_HOLD_MS } from '../src/server.js';
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
const BEATS = { [ROCK]: PAPER, [PAPER]: SCISSORS, [SCISSORS]: ROCK };
const mk = (n) => ({ name: `p${n}`, key: b32(0x50 + n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });
const salt = () => new Uint8Array(randomBytes(32));
const results = (w, eid) => w.nodes.map((d) => d.round.results(w.rid, eid).map((r) => { const p = decodePlayerResult(splitSignedResult(r.bytes).body); return `${p.outcome} ${p.score}`; }));
const reveal = (w, played, move, s) => Promise.all(w.nodes.map(async (d) => (await fetch(`http://127.0.0.1:${d.port}/reveal?entry=${toHex(played.eid)}`, { method: 'POST', body: JSON.stringify({ move, salt: toHex(s) }) })).status));
const keyOf = (op) => `${toHex(op.txid)}:${op.outIdx}`;
const pause = (ms) => new Promise((go) => setTimeout(go, ms));

test('#1827 (1.9) #1598 refute s2-1: three stake locks handed before the close, the federation read after it - only the winner submitted after the reveal', async () => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS], entryCloseGraceMs: 15000 }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 25000 });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const hs = salt();
    const honest = await lockAndPlay(w, mk(1), { hidden: { move: ROCK, salt: hs }, noMarks: true });
    const moves = {};
    for (const move of [ROCK, PAPER, SCISSORS]) {
      const s = salt();
      moves[move] = { played: await lockAndPlay(w, mk(2 + move), { hidden: { move, salt: s }, noMarks: true, only: [], feeFirst: true }), salt: s };
    }
    // THE FEDERATION, AS THE ATTACKER LEAVES IT: none of his three stake transactions submitted yet. A seat's read of it is on its way
    // (the stock client's lane) until `release`; then it holds only the transaction he submitted - the winner's.
    const attackerOps = new Map(Object.entries(moves).map(([m, v]) => [keyOf(v.played.outpoint), Number(m)]));
    let release, submitted = null, readsWaiting = 0;
    const gate = new Promise((go) => { release = go; });
    const realStatus = w.port.status;
    w.port.status = async (op) => {
      const m = attackerOps.get(keyOf(op));
      if (m === undefined) return realStatus(op);
      readsWaiting++;
      await gate;
      if (m === submitted) return realStatus(op);
      return { blockCount: w.port.height, stored: null };
    };
    // just before the close: all three stake locks at every seat, the answers not awaited
    skipTo(Number(w.c.entryCloseMs) - 400);
    const handed = [];
    for (const move of [ROCK, PAPER, SCISSORS]) for (const d of w.nodes) {
      const p = moves[move].played;
      handed.push(fetch(`http://127.0.0.1:${d.port}/lock?entry=${toHex(p.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(p.fields)) })
        .then(async (r) => ({ move, seat: w.nodes.indexOf(d), said: `${r.status} ${(await r.text()).slice(0, 90)}` })));
    }
    for (const stop = Date.now() + 5000; Date.now() < stop && readsWaiting < 6; await pause(20));
    const passedDoor = readsWaiting;
    // the close: the honest page reveals; GET /reveals is public
    skipTo(Number(w.c.entryCloseMs) + 300);
    await reveal(w, honest, ROCK, hs);
    skipTo(Number(w.c.entryCloseMs) + H2H_REVEAL_HOLD_MS + 100);   // 1.9 serves no move before the close + the hold (#1822)
    const pub = await (await fetch(`http://127.0.0.1:${w.nodes[0].port}/reveals?round=${toHex(w.rid)}`)).json();
    const seen = pub.reveals.find((r) => r.entry === toHex(honest.eid)).move;
    const win = BEATS[seen];
    // he submits only the winning entry's transaction; the seats' reads finish
    submitted = win;
    skipTo(Number(w.c.entryCloseMs) + H2H_REVEAL_HOLD_MS + 600);
    release();
    const answers = await Promise.all(handed);
    w.port.status = realStatus;
    await reveal(w, moves[win].played, win, moves[win].salt);
    await closeRound(w);
    const settled = await untilSettled(w, 20000);
    const got = { honest: results(w, honest.eid), attacker: results(w, moves[win].played.eid) };
    const heldAt = w.nodes.map((d) => !!d.round.stakeLock(moves[win].played.eid));
    console.log('  FACTS (#1598 refute s2-1):', JSON.stringify({ passedDoor, seen, lockedMove: win, answers, heldAt, results: got, state: settled && settled.state }));
    const attackerWon = got.attacker.every((per) => per.includes('DELIVERED 2'));
    assert.equal(attackerWon, false, `the winning stake lock reached the federation only after the honest reveal was public, and every seat seated it: ${JSON.stringify({ heldAt, got })}`);
  } finally { await w.close(); }
});
