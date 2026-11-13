// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 state machine audit 2026-11-13 (sm1-find-h2h 3): ONE SEAT SIGNS BOTH PLAYERS OF ONE HEAD-TO-HEAD ROUND THE WINNER.
// Machine: a head-to-head verdict per seat (verify.js #headToHeadClose, #retryClose; SM-R #1586, H2H #1589). The round's verdicts are one decision
// (headToHeadResults over the reveals held), but a retry "signs only the entry it was asked for" and decides again from its OWN fresh /reveals pull.
// Past the result window (#1589 stops waiting there) the finality watch retries each unsigned entry in turn; a peer that holds a reveal answers one
// pull and misses the next (busy, restarting, a timeout). The retry of A, with that peer silent, decides A the lone revealer (WIN) and signs A; the
// retry of B a moment later reaches the peer, carries B's reveal and decides B WIN (paper beats rock). One seat holds two WINs for a two-player round:
// its settlement claims no loser's lock, its verdicts contradict each other and the other seats', and the honest winner B is not paid by it.
// Invariant: every verdict one seat signs for a head-to-head round comes from ONE decision over one reveal set - never WIN for both players.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { b32, say } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { RPS, RPS_CORE_HASH, RPS_CONFIG_HASH, RPS_GAME_ID } from './plugins/rps/index.js';
import { decodePlayerResult, splitSignedResult } from '../../arena-protocol/src/result.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { windowsOf } from '../../arena-protocol/src/window.js';

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE };
const ROCK = 0, PAPER = 1;
const mk = (n) => ({ name: `p${n}`, key: b32(0x50 + n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });
const salt = () => new Uint8Array(randomBytes(32));
const reveal = async (seats, played, move, s) => Promise.all(seats.map(async (d) => {
  const r = await fetch(`http://127.0.0.1:${d.port}/reveal?entry=${toHex(played.eid)}`, { method: 'POST', body: JSON.stringify({ move, salt: toHex(s) }) });
  return r.status;
}));
const ownOf = (d, rid, eid) => d.round.results(rid, eid).filter((r) => toHex(decodePlayerResult(splitSignedResult(r.bytes).body).nodePubkey) === toHex(d.round.pubkey))
  .map((r) => { const p = decodePlayerResult(splitSignedResult(r.bytes).body); return `${p.outcome} ${p.score}`; });

test('#1489 sm1-find-h2h 3: per-entry retries past the result window decide each entry from its own pull - one seat signs both players WIN', { timeout: 110000 }, async () => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS] }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 4000 });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const sa = salt(), sb = salt();
    const a = await lockAndPlay(w, mk(1), { hidden: { move: ROCK, salt: sa }, noMarks: true });
    const b = await lockAndPlay(w, mk(2), { hidden: { move: PAPER, salt: sb }, noMarks: true });
    skipTo(Number(w.c.entryCloseMs) + 500);
    // A reveals at both seats; B's page counted its reveal sent at seat 0's 201 (its post to seat 1 was lost)
    const said = { a: await reveal(w.nodes, a, ROCK, sa), b: await reveal([w.nodes[0]], b, PAPER, sb) };
    const [, s1] = w.nodes, real = s1.verifier.peers;
    const DOWN = ['http://127.0.0.1:9'];
    s1.verifier.peers = DOWN;                         // seat 0 does not answer seat 1 (busy / restarting)
    await say(s1.port, `close ${toHex(w.rid)}`);
    for (const p of s1.verifier.done || []) { try { await p; } catch { /* said itself */ } }
    // past the result window (#1589 waits only until then); seat 0 still silent for this pull
    skipTo(Number(windowsOf(w.c).finalAfterMs) + 1000);
    const ra = await s1.verifier.retryClose(w.rid, a.eid);
    // seat 0 answers the very next pull
    s1.verifier.peers = real;
    const rb = await s1.verifier.retryClose(w.rid, b.eid);
    const got = { said, retryA: ra && `${ra.stored} ${ra.outcome} ${ra.score}`, retryB: rb && `${rb.stored} ${rb.outcome} ${rb.score}`,
      a: ownOf(s1, w.rid, a.eid), b: ownOf(s1, w.rid, b.eid), revealsAtSeat1: s1.round.revealsOf(w.rid).length };
    console.log('  FACTS:', JSON.stringify(got));
    const wins = [...got.a, ...got.b].filter((x) => x.startsWith('DELIVERED 2')).length;
    assert.ok(wins <= 1, `seat 1 signed ${wins} winners for one two-player round: ${JSON.stringify(got)}`);
  } finally { await w.close(); }
});
