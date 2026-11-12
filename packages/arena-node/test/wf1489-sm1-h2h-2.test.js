// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 state machine audit (sm1-h2h-2): A PEER THAT DID NOT ANSWER AT ONE SEAT'S CLOSE FIXES THAT SEAT'S HEAD-TO-HEAD VERDICT FOREVER.
// Machine: a head-to-head reveal per seat (SM-11): none -> held (door, in the window) | held (carried from a peer at this seat's close, once).
// The page's reveal counts as sent when ONE seat answered 200/201 (SM-P3), so a reveal may stand at one seat only. Another seat closes, pulls the
// peers' /reveals once (verify.js carryReveals), and that peer does not answer in time (busy, restarting, a timeout): it decides without the reveal
// - the honest revealer FORFEIT, his opponent the lone revealer and the WINNER - and signs. Nothing ever asks again: the result is kept once
// (INSERT OR IGNORE), the restart re-close skips an entry with a result, and the seat that holds the reveal signs the opposite verdict. The two seats
// of the round disagree for good: neither verdict reaches the threshold, the round never settles, the honest winner is never paid.
// Invariant: an entry's result at every seat is decided from every reveal that stood in the window at any seat of the round.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { lockRound, lockAndPlay, closeRound, untilSettled } from './lock-round-fixture.js';
import { b32, say } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { RPS, RPS_CORE_HASH, RPS_CONFIG_HASH, RPS_GAME_ID } from './plugins/rps/index.js';
import { decodePlayerResult, splitSignedResult } from '../../arena-protocol/src/result.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE };
const ROCK = 0, PAPER = 1;
const mk = (n) => ({ name: `p${n}`, key: b32(0x40 + n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });
const salt = () => new Uint8Array(randomBytes(32));
const results = (w, eid) => w.nodes.map((d) => d.round.results(w.rid, eid).map((r) => {
  const p = decodePlayerResult(splitSignedResult(r.bytes).body);
  return `${p.outcome} ${p.score}`;
}));
const reveal = async (seats, played, move, s) => Promise.all(seats.map(async (d) => {
  const r = await fetch(`http://127.0.0.1:${d.port}/reveal?entry=${toHex(played.eid)}`, { method: 'POST', body: JSON.stringify({ move, salt: toHex(s) }) });
  return r.status;
}));

test('#1489 sm1-h2h-2: a seat whose peer did not answer at its close never takes the reveal it missed, and the seats sign opposite verdicts', { timeout: 110000 }, async () => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS] }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 4000 });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const sa = salt(), sb = salt();
    const a = await lockAndPlay(w, mk(1), { hidden: { move: ROCK, salt: sa }, noMarks: true });
    const b = await lockAndPlay(w, mk(2), { hidden: { move: PAPER, salt: sb }, noMarks: true });
    skipTo(Number(w.c.entryCloseMs) + 500);
    // A reveals at both seats; B's page counts its reveal sent at seat 0's 201 (the post to seat 1 was lost)
    const said = { a: await reveal(w.nodes, a, ROCK, sa), b: await reveal([w.nodes[0]], b, PAPER, sb) };
    // seat 1 closes while seat 0 does not answer (a port nobody listens on stands for a busy or restarting seat)
    const [s0, s1] = w.nodes, real = s1.verifier.peers;
    s1.verifier.peers = ['http://127.0.0.1:9'];
    await say(s1.port, `close ${toHex(w.rid)}`);
    for (const p of s1.verifier.done || []) { try { await p; } catch { /* said itself */ } }
    s1.verifier.peers = real;                 // seat 0 answers again from here on
    await closeRound(w);
    const settled = await untilSettled(w, 15000);
    // what each seat SIGNED itself, by signer key
    const own = (eid) => w.nodes.map((d) => d.round.results(w.rid, eid).filter((r) => toHex(decodePlayerResult(splitSignedResult(r.bytes).body).nodePubkey) === toHex(d.round.pubkey))
      .map((r) => { const p = decodePlayerResult(splitSignedResult(r.bytes).body); return `${p.outcome} ${p.score}`; }));
    const got = { a: own(a.eid), b: own(b.eid), reveals: w.nodes.map((d) => d.round.revealsOf(w.rid).length), settlement: settled && settled.state, why: settled && String(settled.why || '').slice(0, 160) };
    console.log('  FACTS:', JSON.stringify({ said, ...got }));
    assert.deepEqual(got.b[1], got.b[0], `seat 0 and seat 1 signed different verdicts for B, who revealed in time: ${JSON.stringify(got)}`);
    assert.deepEqual(got.a[1], got.a[0], `seat 0 and seat 1 signed different verdicts for A: ${JSON.stringify(got)}`);
    assert.equal(settled && settled.state, 'ACCEPTED', `the round never settles: ${JSON.stringify(got)}`);
  } finally { await w.close(); }
});
