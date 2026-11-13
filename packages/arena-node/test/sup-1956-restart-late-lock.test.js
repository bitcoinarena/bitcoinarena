// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 skeptic 2 (round b) on #1598 at 25e44e415: THE RESTART PATH. #1882 refuses a late-read head-to-head lock once another seat
// SERVED a move of the round, and a seat answers that on GET /reveals-served from h2hServed - a Set in memory, never stored. A seat that
// served the honest move and then restarts (a deploy, a crash, the health watcher, or its own operator) answers "served: false" for that
// round. The #1827 attacker hands his three stake locks to seat 0 only before the close; seat 1 serves the honest move; seat 1 restarts;
// he submits the winner's transaction; seat 0's read ends, asks the restarted seat 1, hears "not served", and keeps the chosen lock.
// Adapted to 1.9 by #2536 (kanban #1956): 1.9 has no GET /reveals-served (the #1827 / #1882 line never landed there); it serves no move of a
// paying head-to-head round before close + H2H_REVEAL_HOLD_MS (#1822) and drops a lock's door time when the federation's answer comes back
// once the seat holds another entry's reveal or after close + the hold (#1846). The same attack: locks handed to seat 0 only before the
// close, their reads held, seat 1 restarts on its store, the attacker reads the honest move once it is served and submits the winner.
// Safe behaviour: a move a seat served is still "served" after that seat restarts, and the chosen lock is refused (409) at seat 0.
import { serve, H2H_REVEAL_HOLD_MS } from '../src/server.js';
import { opts } from './window-fixture.js';
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
const BEATS = { [ROCK]: PAPER, [PAPER]: SCISSORS, [SCISSORS]: ROCK };
const mk = (n) => ({ name: `p${n}`, key: b32(0x70 + n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });
const salt = () => new Uint8Array(randomBytes(32));
const results = (w, eid) => w.nodes.map((d) => d.round.results(w.rid, eid).map((r) => { const p = decodePlayerResult(splitSignedResult(r.bytes).body); return `${p.outcome} ${p.score}`; }));
const reveal = (w, played, move, s) => Promise.all(w.nodes.map(async (d) => (await fetch(`http://127.0.0.1:${d.port}/reveal?entry=${toHex(played.eid)}`, { method: 'POST', body: JSON.stringify({ move, salt: toHex(s) }) })).status));
const keyOf = (op) => `${toHex(op.txid)}:${op.outIdx}`;
const pause = (ms) => new Promise((go) => setTimeout(go, ms));


test('#1956 (1.9) #1598 refute b s2-2: a seat that served the honest move restarts, says "not served", and the chosen late lock is kept', async () => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS], entryCloseGraceMs: 15000 }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 25000 });
  let again = null;
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const hs = salt();
    const honest = await lockAndPlay(w, mk(1), { hidden: { move: ROCK, salt: hs }, noMarks: true });
    const moves = {};
    for (const move of [ROCK, PAPER, SCISSORS]) {
      const s = salt();
      moves[move] = { played: await lockAndPlay(w, mk(2 + move), { hidden: { move, salt: s }, noMarks: true, only: [], feeFirst: true }), salt: s };
    }
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
    skipTo(Number(w.c.entryCloseMs) - 400);
    const handed = [];
    for (const move of [ROCK, PAPER, SCISSORS]) {
      const p = moves[move].played;
      handed.push(fetch(`http://127.0.0.1:${w.nodes[0].port}/lock?entry=${toHex(p.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(p.fields)) })
        .then(async (r) => ({ move, status: r.status, said: (await r.text()).slice(0, 200) })));
    }
    for (const stop = Date.now() + 5000; Date.now() < stop && readsWaiting < 3; await pause(20));
    skipTo(Number(w.c.entryCloseMs) + 300);
    await reveal(w, honest, ROCK, hs);
    console.log('  STEP revealed');
    skipTo(Number(w.c.entryCloseMs) + H2H_REVEAL_HOLD_MS + 100);   // 1.9 serves no move before the close + the hold (#1822)
    const at1 = await (await fetch(`http://127.0.0.1:${w.nodes[1].port}/reveals?round=${toHex(w.rid)}`)).json();
    const seen = at1.reveals.find((r) => r.entry === toHex(honest.eid));
    submitted = BEATS[seen.move];
    const servedBefore = true;
    console.log('  STEP served', seen.move);
    // SEAT 1 RESTARTS: the same store, the same port, the same code
    const port1 = w.nodes[1].port, store1 = w.nodes[1].round.db;
    await w.nodes[1].close();
    again = await serve(store1, { ...opts, plugins: [NEXTBLOCK, RPS], entryCloseGraceMs: 15000, port: port1 });
    console.log('  STEP restarted', again.port);
    let servedAfter = null;
    for (let i = 0; i < 10 && servedAfter === null; i++) { try { servedAfter = (await (await fetch(`http://127.0.0.1:${port1}/reveals?round=${toHex(w.rid)}`)).json()).reveals.length > 0; } catch { await pause(100); } }
    skipTo(Number(w.c.entryCloseMs) + H2H_REVEAL_HOLD_MS + 600);
    release();
    const answers = await Promise.all(handed);
    w.port.status = realStatus;
    const won = answers.find((a) => a.move === submitted);
    console.log('  FACTS (#1598 refute b s2-2):', JSON.stringify({ servedBefore, servedAfter, submitted, answers }));
    assert.equal(servedBefore, true, 'seat 1 served the honest move');
    assert.equal(won.status, 409, `the lock chosen from a move seat 1 served before its restart was kept at seat 0: ${won.said}`);
  } finally { if (again) await again.close(); w.nodes.splice(1, 1); await w.close(); }
});
